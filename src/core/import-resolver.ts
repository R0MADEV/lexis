// Attributes a reference to the definition it actually binds to, using the
// file's own import statements.
//
// This is not a heuristic: for a module-scoped symbol the import IS the binding
// the language performs. It needs no type inference, so it works without an LSP.
// It stops short where imports stop carrying the answer — method calls bind by
// receiver type, same-package symbols need no import, dynamic dispatch names
// nothing — and those cases return null rather than a guess.

import * as path from "path";

const SOURCE_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".php", ".go", ".rs",
];

// A python-style relative specifier: leading dots followed by a module name
// (".home"), as opposed to a path-style one ("./home").
const PY_RELATIVE = /^\.+\w/;

// A namespaced specifier: python "app.core.home", php "App\\Home\\Widget",
// rust "crate::home::handle_click". A single bare word (an npm package) is not
// one — it names no path.
const NAMESPACED = /^[A-Za-z_]\w*(?:(?:\\|::|\.)[A-Za-z_]\w*)+$/;

function mentionsSymbol(clause: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(clause);
}

// Returns the module specifier `symbol` is imported from, or null when the file
// does not import it under that name. `[^;]` bounds each clause to a single
// statement, so a bare `import './polyfill';` cannot swallow what follows it.
export function findImportSpecifier(content: string, symbol: string): string | null {
  const forms: Array<{ re: RegExp; clause: 1 | 2; spec: 1 | 2 }> = [
    // import { a, b as c } from "mod" / import d from "mod" / export { a } from "mod"
    { re: /(?:import|export)\s+([^;]*?)\s+from\s*["']([^"']+)["']/g, clause: 1, spec: 2 },
    // from .mod import a, b
    { re: /^[ \t]*from\s+([.\w]+)\s+import\s+(.+)$/gm, clause: 2, spec: 1 },
    // use crate::mod::item;  /  use App\Mod\Item;
    { re: /^[ \t]*use\s+([^;]+);/gm, clause: 1, spec: 1 },
  ];

  for (const form of forms) {
    form.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = form.re.exec(content)) !== null) {
      const clause = m[form.clause];
      if (clause && mentionsSymbol(clause, symbol)) return (m[form.spec] ?? "").trim();
    }
  }
  return null;
}

// Every on-disk form a module specifier can point at.
function candidateTargets(target: string): string[] {
  const forms = [target];
  for (const ext of SOURCE_EXTENSIONS) {
    forms.push(target + ext);
    forms.push(path.join(target, "index" + ext));
  }
  return forms;
}

// Namespaces mirror directories: PSR-4 mandates it for php, the module system
// enforces it for rust, packages do it for python. So the trailing segments
// identify the file without reading composer.json or locating the crate root —
// only the leading segments, which map to a configured base directory, are
// unknown, and dropping them progressively covers that.
function namespacedCores(specifier: string): string[] {
  const segments = specifier.split(/\\|::|\./).filter(Boolean);
  // `crate::` is this crate's source root, conventionally src/.
  const rooted = segments[0] === "crate" ? ["src", ...segments.slice(1)] : segments;

  // The last segment may be the imported item rather than a module, so each
  // depth is tried both with it and without it, longest first.
  const cores: Array<{ core: string; depth: number; dropped: number }> = [];
  for (const dropped of [0, 1]) {
    const segs = dropped ? rooted.slice(0, -1) : rooted;
    for (let depth = segs.length; depth >= 1; depth--) {
      cores.push({ core: segs.slice(segs.length - depth).join(path.sep), depth, dropped });
    }
  }

  return cores
    .sort((a, b) => b.depth - a.depth || a.dropped - b.dropped)
    .map((c) => c.core);
}

function matchesCore(candidate: string, core: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) =>
    candidate.endsWith(path.sep + core + ext) ||
    candidate.endsWith(path.sep + core + path.sep + "mod" + ext) ||
    candidate.endsWith(path.sep + core + path.sep + "index" + ext)
  );
}

function pythonRelativeTarget(fromFile: string, specifier: string): string {
  const depth = specifier.match(/^\.+/)?.[0].length ?? 1;
  let base = path.dirname(fromFile);
  for (let i = 1; i < depth; i++) base = path.dirname(base);
  return path.join(base, specifier.slice(depth).split(".").join(path.sep));
}

// Maps an import specifier written in `fromFile` onto one of `candidates`.
// Returns null for anything it cannot map to a file with certainty — a package
// import, an unresolvable alias, a namespace whose layout it does not know.
export function resolveImportToCandidate(
  fromFile: string,
  specifier: string,
  candidates: string[],
): string | null {
  const isRelative = specifier.startsWith(".");

  if (isRelative) {
    const target = PY_RELATIVE.test(specifier)
      ? pythonRelativeTarget(fromFile, specifier)
      : path.resolve(path.dirname(fromFile), specifier);
    const targets = new Set(candidateTargets(target));
    return candidates.find((c) => targets.has(c)) ?? null;
  }

  if (NAMESPACED.test(specifier)) {
    // Try the most specific path core first. The first core that matches exactly
    // one candidate wins; a core matching several is ambiguous and resolves to
    // nothing, because a wrong attribution is worse than an unattributed one.
    for (const core of namespacedCores(specifier)) {
      const matches = candidates.filter((c) => matchesCore(c, core));
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) return null;
    }
  }

  return null;
}

export interface Attribution {
  file: string;
  via: "only-definition" | "local" | "import";
}

// Which definition of `symbol` does `file` see? null means no binding could be
// established — the caller must report it as unattributed, not guess.
export function attributeReference(
  file: string,
  content: string,
  symbol: string,
  candidates: string[],
): Attribution | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { file: candidates[0]!, via: "only-definition" };

  // A definition in the same file shadows anything imported into it.
  if (candidates.includes(file)) return { file, via: "local" };

  const specifier = findImportSpecifier(content, symbol);
  if (!specifier) return null;

  const resolved = resolveImportToCandidate(file, specifier, candidates);
  return resolved ? { file: resolved, via: "import" } : null;
}

export interface AttributedReferences<T> {
  byDefinition: Map<string, T[]>;
  unattributed: T[];
}

// Splits references by the definition each one binds to. Files are read through
// the injected `readFile` so callers can pass a cache they already fill, and
// each referencing file is attributed once however many references it holds.
// With a single definition there is nothing to decide and no file is read.
export function attributeReferences<T extends { file: string }>(
  refs: T[],
  symbol: string,
  definitions: string[],
  readFile: (file: string) => string,
): AttributedReferences<T> {
  const byDefinition = new Map<string, T[]>();
  const unattributed: T[] = [];

  const push = (definition: string, ref: T): void => {
    const existing = byDefinition.get(definition);
    if (existing) existing.push(ref);
    else byDefinition.set(definition, [ref]);
  };

  const isUnambiguous = definitions.length === 1;
  const perFile = new Map<string, string | null>();

  for (const ref of refs) {
    if (isUnambiguous) {
      push(definitions[0]!, ref);
      continue;
    }
    if (!perFile.has(ref.file)) {
      const attribution = attributeReference(ref.file, readFile(ref.file), symbol, definitions);
      perFile.set(ref.file, attribution?.file ?? null);
    }
    const definition = perFile.get(ref.file) ?? null;
    if (definition) push(definition, ref);
    else unattributed.push(ref);
  }

  return { byDefinition, unattributed };
}
