// Reference-tracking tools: find_references, get_context, find_writes.
// All share the convention of returning a 3-line context window around
// each hit so Claude doesn't have to read_file for each one.

import * as fs from "fs";
import * as path from "path";
import { findReferences, getContext, suggestSimilar } from "../../core/searcher";
import { attributeReferences } from "../../core/import-resolver";
import { Index } from "../../core/indexer";
import { log } from "../runtime/jsonrpc";
import { runRg } from "../runtime/ripgrep";
import { formatSuggestions } from "../runtime/format";

export function execFindReferences(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const symbol = args["symbol"] as string;
  const depth = typeof args["depth"] === "number" ? Math.min(Math.max(1, args["depth"]), 2) : 1;
  const definedIn = args["defined_in"] as string | undefined;

  log(`[find_references] symbol="${symbol}" depth=${depth} defined_in=${definedIn ?? "none"}`);

  const root = path.resolve(projectPath);
  const definitions = [...new Set(index.symbols.filter((s) => s.name === symbol).map((s) => s.file))];
  const listDefinitions = (): string =>
    definitions.map((d) => `  ${path.relative(root, d)}`).join("\n");

  let target: string | null = null;
  if (definedIn) {
    const needle = definedIn.toLowerCase();
    const matches = definitions.filter((d) => d.toLowerCase().includes(needle));
    if (matches.length === 0) {
      return `No definition of "${symbol}" lives in a path matching "${definedIn}". Known definitions:\n${listDefinitions()}`;
    }
    if (matches.length > 1) {
      const list = matches.map((m) => `  ${path.relative(root, m)}`).join("\n");
      return `"${definedIn}" matches ${matches.length} definitions of "${symbol}" — narrow it:\n${list}`;
    }
    target = matches[0]!;
  }

  const refs = findReferences(symbol, projectPath, index);
  if (refs.length === 0) {
    const suggestions = suggestSimilar(symbol, index, 5);
    return `No references found for "${symbol}".${formatSuggestions(suggestions, path.resolve(projectPath))}`;
  }

  const projectRoot = path.resolve(projectPath);
  const fileCache = new Map<string, string[]>();
  const getLines = (file: string): string[] => {
    if (!fileCache.has(file)) {
      try { fileCache.set(file, fs.readFileSync(file, "utf-8").split("\n")); }
      catch { fileCache.set(file, []); }
    }
    return fileCache.get(file)!;
  };

  const formatRef = (r: { file: string; line: number; kind: string; content: string }, label?: string): string => {
    const relFile = path.relative(projectRoot, r.file);
    const header = `${label ?? ""}${relFile}:${r.line}  [${r.kind}]`;
    if (r.kind === "import") return `${header}  ${r.content}`;
    const lines = getLines(r.file);
    if (lines.length === 0) return `${header}  ${r.content.slice(0, 80)}`;
    const start = Math.max(0, r.line - 1 - 2);
    const end   = Math.min(lines.length, r.line - 1 + 3);
    const ctx: string[] = [];
    for (let i = start; i < end; i++) {
      ctx.push(`  ${i + 1 === r.line ? "→" : " "} ${i + 1}: ${lines[i]}`);
    }
    return `${header}\n${ctx.join("\n")}`;
  };

  // definitions first, then calls, types, other, imports last
  const KIND_ORDER: Record<string, number> = { definition: 0, call: 1, type: 2, other: 3, import: 4 };
  const byKind = <T extends { kind: string }>(list: T[]): T[] =>
    [...list].sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9));
  const MAX = 25;
  const render = (list: typeof refs): string => byKind(list).map((r) => formatRef(r)).join("\n\n");

  const UNBOUND_NOTE =
    "name matches no import binds to a definition — a method call, a same-package symbol, or dynamic dispatch";

  let body: string;

  // One definition: nothing to disambiguate, keep the flat output.
  if (definitions.length <= 1) {
    const shown = byKind(refs).slice(0, MAX);
    const overflow = refs.length - shown.length;
    body = `${refs.length} references to "${symbol}":\n\n${shown.map((r) => formatRef(r)).join("\n\n")}`;
    if (overflow > 0) body += `\n\n[${overflow} more references omitted]`;
  } else {
    const { byDefinition, unattributed } = attributeReferences(
      refs, symbol, definitions, (f) => getLines(f).join("\n")
    );

    if (target) {
      const mine = (byDefinition.get(target) ?? []).slice(0, MAX);
      const total = byDefinition.get(target)?.length ?? 0;
      const overflow = total - mine.length;
      body = `${total} references to "${symbol}" defined in ${path.relative(root, target)}:\n\n${mine.map((r) => formatRef(r)).join("\n\n")}`;
      if (overflow > 0) body += `\n\n[${overflow} more references omitted]`;
      if (unattributed.length > 0) {
        body += `\n\n[${unattributed.length} further reference(s) could not be bound to any definition — ${UNBOUND_NOTE}. Omit defined_in to see them.]`;
      }
    } else {
      const sections = [...byDefinition.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([definition, list]) => {
          const shown = list.slice(0, MAX);
          const omitted = list.length - shown.length;
          const tail = omitted > 0 ? `\n\n[${omitted} more omitted]` : "";
          return `DEFINITION: ${path.relative(root, definition)}  (${list.length} ref${list.length === 1 ? "" : "s"})\n\n${render(shown)}${tail}`;
        });

      if (unattributed.length > 0) {
        const shown = unattributed.slice(0, MAX);
        const omitted = unattributed.length - shown.length;
        const tail = omitted > 0 ? `\n\n[${omitted} more omitted]` : "";
        sections.push(`UNATTRIBUTED (${unattributed.length}) — ${UNBOUND_NOTE}:\n\n${render(shown)}${tail}`);
      }

      body = `${refs.length} references to "${symbol}", across ${definitions.length} definitions of that name. Pass defined_in to scope to one:\n\n${sections.join("\n\n")}`;
    }
  }

  // depth=2: trace callers of each direct caller using the index
  if (depth >= 2) {
    const GENERIC_FN = new Set([
      "__construct", "constructor", "init", "__init__", "setUp", "tearDown",
      "create", "build", "make", "get", "set", "run", "execute", "handle", "process",
      "render", "main", "test", "factory", "instance", "default",
    ]);
    const callerNames = new Set<string>();
    // include 'other' to catch DI / property declarations (typed constructor args in PHP, fields in Java/C#)
    for (const ref of refs.filter((r) => r.kind === "call" || r.kind === "type" || r.kind === "other")) {
      // find the innermost indexed symbol that contains this reference line
      const enc = index.symbols
        .filter((s) => s.file === ref.file && s.lineStart <= ref.line)
        .sort((a, b) => b.lineStart - a.lineStart)[0];
      if (!enc || enc.name.length < 4 || enc.name === symbol) continue;
      // walk up the file's symbols to find a non-generic enclosing context
      let chosen = enc;
      if (GENERIC_FN.has(enc.name)) {
        const parent = index.symbols
          .filter((s) => s.file === ref.file && s.lineStart < enc.lineStart && s.type === "class")
          .sort((a, b) => b.lineStart - a.lineStart)[0];
        if (parent) chosen = parent;
      }
      if (!GENERIC_FN.has(chosen.name)) callerNames.add(chosen.name);
    }

    const depth2Refs: Array<typeof refs[number] & { via: string }> = [];
    const knownFiles = new Set(refs.map((r) => r.file));

    for (const callerName of [...callerNames].slice(0, 4)) {
      const callerRefs = findReferences(callerName, projectPath, index);
      for (const r of callerRefs) {
        if (knownFiles.has(r.file)) continue;
        if (r.kind === "definition") continue;  // skip self-defs
        depth2Refs.push({ ...r, via: callerName });
        knownFiles.add(r.file);
        if (depth2Refs.length >= 10) break;
      }
      if (depth2Refs.length >= 10) break;
    }

    if (depth2Refs.length > 0) {
      const d2Parts = depth2Refs.map((r) => formatRef(r, `(via ${r.via}) `));
      body += `\n\nCALLERS OF CALLERS (depth 2):\n\n${d2Parts.join("\n\n")}`;
    }
  }

  return body;
}

export function execGetContext(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const file = args["file"] as string;
  const line = typeof args["line"] === "number" ? args["line"] : parseInt(args["line"] as string, 10);

  log(`[get_context] file="${file}" line=${line}`);

  const ctx = getContext(file, line, projectPath, index);
  const projectRoot = path.resolve(projectPath);

  const relFile = path.isAbsolute(file)
    ? path.relative(projectRoot, file)
    : file;

  const fnLabel = ctx.fnName ?? "(anonymous)";
  const parts: string[] = [];

  parts.push(`FUNCTION: ${fnLabel} (${relFile}:${ctx.fnLineStart}-${ctx.fnLineEnd})\n\n\`\`\`\n${ctx.fnCode}\n\`\`\``);

  if (ctx.callers.length > 0) {
    const fileCache = new Map<string, string[]>();
    const getLines = (f: string): string[] => {
      if (!fileCache.has(f)) {
        try { fileCache.set(f, fs.readFileSync(f, "utf-8").split("\n")); }
        catch { fileCache.set(f, []); }
      }
      return fileCache.get(f)!;
    };

    const callerParts = ctx.callers.slice(0, 5).map((r) => {
      const rel = path.relative(projectRoot, r.symbol.file);
      const fileLines = getLines(r.symbol.file);
      if (fileLines.length === 0) return `  ${rel}:${r.symbol.lineStart}  ${r.code.split("\n")[0]}`;

      // find the line within the caller chunk that actually calls our function
      const searchName = ctx.fnName ?? "";
      let callLine = r.symbol.lineStart;
      for (let i = r.symbol.lineStart - 1; i < Math.min(r.symbol.lineEnd, fileLines.length); i++) {
        if (searchName && (fileLines[i] ?? "").includes(searchName)) { callLine = i + 1; break; }
      }

      const start = Math.max(0, callLine - 1 - 2);
      const end   = Math.min(fileLines.length, callLine - 1 + 3);
      const ctx2 = [];
      for (let i = start; i < end; i++) {
        const n = i + 1;
        ctx2.push(`  ${n === callLine ? "→" : " "} ${n}: ${fileLines[i]}`);
      }
      return `  ${rel}:${callLine}\n${ctx2.join("\n")}`;
    });

    parts.push(`CALLED BY (${ctx.callers.length}):\n${callerParts.join("\n\n")}`);
  } else {
    parts.push(`CALLED BY: none found (may be an entry point or exported API)`);
  }

  if (ctx.types.length > 0) {
    const typeLines = ctx.types.slice(0, 6).map((r) => {
      const rel = path.relative(projectRoot, r.symbol.file);
      return `  ${rel}:${r.symbol.lineStart}  [${r.symbol.type}]  ${r.symbol.name}`;
    });
    parts.push(`TYPES (${ctx.types.length}):\n${typeLines.join("\n")}`);
  }

  if (ctx.tests.length > 0) {
    const testLines = ctx.tests.slice(0, 3).map((r) => {
      const rel = path.relative(projectRoot, r.symbol.file);
      const lineCount = r.symbol.lineEnd - r.symbol.lineStart + 1;
      return `  ${rel}  (${lineCount} lines)`;
    });
    parts.push(`TESTS:\n${testLines.join("\n")}`);
  }

  return parts.join("\n\n");
}

export function execFindWrites(
  args: Record<string, unknown>,
  projectPath: string
): string {
  const target = args["target"] as string;
  if (!target || target.length < 2) return "Error: 'target' must be at least 2 chars.";

  log(`[find_writes] target="${target}"`);

  // Match the basename and any path that ends with the target — handles both
  // 'config.json' and '/etc/myapp/config.json' callers.
  const targetEsc = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Patterns that indicate a write to `target` (cross-language)
  const patterns = [
    // PHP
    `file_put_contents\\s*\\([^)]*${targetEsc}`,
    `fopen\\s*\\([^)]*${targetEsc}[^)]*['"][wa]`,
    `fwrite\\s*\\([^)]*${targetEsc}`,
    // JS / TS / Node
    `fs\\.(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\\s*\\([^)]*${targetEsc}`,
    `writeFile(Sync)?\\s*\\([^)]*${targetEsc}`,
    // Python
    `open\\s*\\([^)]*${targetEsc}[^)]*['"][wax]`,
    `\\.write\\s*\\([^)]*\\).*${targetEsc}`,
    // Ruby
    `File\\.(open|write)\\s*\\([^)]*${targetEsc}`,
    // Bash / shell redirects
    `>\\s*[^|;&\\n]*${targetEsc}`,
    `tee\\s+[^|;&\\n]*${targetEsc}`,
    // Perl
    `open\\s*\\([^,)]*,\\s*['"]>+[^'"]*${targetEsc}`,
    `print\\s+\\$?\\w+\\s+[^;]*${targetEsc}`,
    // Generic: variable assignment with the target nearby
    `\\$?\\w+\\s*=\\s*['"][^'"]*${targetEsc}`,
  ];

  const rgArgs = [
    "--line-number", "--no-heading", "--max-filesize", "200K",
    "-e", patterns.join("|"),
    "--glob", "!node_modules/**", "--glob", "!vendor/**", "--glob", "!.git/**",
    "--glob", "!dist/**", "--glob", "!build/**",
    projectPath,
  ];

  let stdout = runRg(rgArgs).stdout;

  if (!stdout.trim()) return `No code found that writes to "${target}".`;

  const projectRoot = path.resolve(projectPath);
  const lines = stdout.trim().split("\n").slice(0, 30);
  const formatted = lines.map((l) => {
    const m = l.match(/^(.+?):(\d+):(.*)$/);
    if (!m) return l;
    const [, file, lineNum, content] = m;
    const rel = path.relative(projectRoot, file ?? "");
    return `${rel}:${lineNum}  ${(content ?? "").trim().slice(0, 140)}`;
  });

  const overflow = stdout.trim().split("\n").length - lines.length;
  const body = `${lines.length} writer(s) for "${target}":\n\n${formatted.join("\n")}`;
  return overflow > 0 ? `${body}\n\n[${overflow} more omitted]` : body;
}
