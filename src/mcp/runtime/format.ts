// Cross-cutting formatting + classification helpers used by multiple tools.
//   • buildTrace        — call-topology view of search results
//   • formatSuggestions — "Did you mean" block for failed lookups
//   • detectLayer       — classify a file path by architectural layer
//   • extractCallNames  — identifiers that look like function calls in a body

import * as path from "path";
import { SearchResult, Suggestion } from "../../core/searcher";

export function buildTrace(results: SearchResult[], projectRoot: string): string {
  const n = results.length;
  const calls: Set<number>[]    = Array.from({ length: n }, () => new Set<number>());
  const calledBy: Set<number>[] = Array.from({ length: n }, () => new Set<number>());

  for (let i = 0; i < n; i++) {
    const codeI = results[i]!.code;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const nameJ = results[j]!.symbol.name;
      if (nameJ.length < 4) continue;
      const escaped = nameJ.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\b`).test(codeI)) {
        calls[i]!.add(j);
        calledBy[j]!.add(i);
      }
    }
  }

  const lines = results.map((r, i) => {
    const rel = path.relative(projectRoot, r.symbol.file);
    const header = `${rel}:${r.symbol.lineStart}  [${r.symbol.type}]  ${r.symbol.name}`;

    const callerLines = [...calledBy[i]!].map((j) => {
      const c = results[j]!;
      return `  ← ${c.symbol.name.padEnd(26)} ${path.relative(projectRoot, c.symbol.file)}:${c.symbol.lineStart}`;
    });
    const calleeLines = [...calls[i]!].map((j) => {
      const c = results[j]!;
      return `  → ${c.symbol.name.padEnd(26)} ${path.relative(projectRoot, c.symbol.file)}:${c.symbol.lineStart}`;
    });

    const rels = [...callerLines, ...calleeLines];
    return rels.length > 0 ? `${header}\n${rels.join("\n")}` : header;
  });

  // entry points first (no callers in this result set)
  lines.sort((a, b) => {
    const aIsEntry = !a.includes("  ←");
    const bIsEntry = !b.includes("  ←");
    if (aIsEntry !== bIsEntry) return aIsEntry ? -1 : 1;
    return 0;
  });

  return `Call topology (${n} symbols):\n\n${lines.join("\n\n")}`;
}

export function formatSuggestions(suggestions: Suggestion[], projectRoot: string): string {
  if (suggestions.length === 0) return "";
  const groups: Record<string, Suggestion[]> = {};
  for (const s of suggestions) {
    (groups[s.reason] ??= []).push(s);
  }
  const labels: Record<string, string> = {
    "case-variant": "Case mismatch",
    "exact-substring": "Substring match",
    "edit-distance": "Closest by typo",
    "token-overlap": "Same words, different order",
  };
  const parts = Object.entries(groups).map(([reason, items]) => {
    const lines = items.map((s) => {
      const rel = path.relative(projectRoot, s.file);
      return `  ${s.name}  [${s.type}]  ${rel}:${s.lineStart}`;
    });
    return `${labels[reason] ?? reason}:\n${lines.join("\n")}`;
  });
  return `\n\nDid you mean:\n${parts.join("\n\n")}`;
}

export function detectLayer(filePath: string): string {
  const f = filePath.replace(/\\/g, "/");
  const base = path.basename(f);
  const isFrontend = /\.(tsx|jsx|vue|svelte)$/.test(base);
  const isBackendExt = /\.(php|go|py|rb|java|kt|cs|rs|swift|scala|ex|pl)$/i.test(base);
  const isMigration  = /\/(migrations?|DoctrineMigrations?|Seeds?|Fixtures?)\//i.test(f);

  // Tests — most specific, check first
  if (/\.(test|spec)\.[^.]+$/i.test(base) || /[/_](tests?|__tests__|specs?|e2e|cypress|spec)\//i.test(f)) return "test";

  // Routes / URL maps
  if (/\/(routes?|router|routing|urls?)[/.]?/i.test(f) || /\b(routes?|urls?)\.[a-z]+$/i.test(base)) return "route";

  // Controllers / HTTP handlers / API actions
  if (/\/(controllers?|handlers?|actions?|resolvers?|mutations?)\//i.test(f)) return "controller";
  if (/(controller|handler|action|resolver)\.[a-z]+$/i.test(base)) return "controller";

  // Services / use-cases / interactors / commands / queries (CQRS) / sagas
  if (/\/(services?|use[-_]?cases?|interactors?|application|usecases?|commands?|queries|sagas?|workflows?|operations?)\//i.test(f)) return "service";
  if (/(service|usecase|interactor|command|handler|saga)\.[a-z]+$/i.test(base)) return "service";

  // Repositories / data access / persistence (hexagonal: adapters/persistence)
  if (/\/(repositor|dao|data[-_]?access|persistence|gateways?)\//i.test(f)) return "repository";
  if (/(repository|gateway|store|persistence)\.[a-z]+$/i.test(base)) return "repository";

  // Domain model (DDD): entities, aggregates, value objects, domain services
  if (!isMigration && isBackendExt) {
    if (/\/(models?|entities?|aggregates?|domain|dto|dtos?|value[-_]?objects?|specifications?)\//i.test(f)) return "model";
    if (/(model|entity|aggregate|valueobject|specification)\.[a-z]+$/i.test(base)) return "model";
  }

  // Cross-cutting: middleware, guards, interceptors, pipes, filters, decorators
  if (/\/(middleware|middlewares?|guards?|interceptors?|pipes?|filters?|decorators?)\//i.test(f)) return "middleware";

  // Ports / adapters (hexagonal architecture)
  if (/\/(ports?|adapters?|infrastructure)\//i.test(f)) {
    // ports = interfaces (model-ish), adapters = impl. Both belong to "model" conceptually
    if (/\/ports?\//i.test(f)) return "model";
    return "repository";
  }

  // State management (Redux / Pinia / Zustand / NgRx / Vuex / Recoil)
  if (/\/(slices?|stores?|reducers?|mutations?|getters?|selectors?|effects?|atoms?)\//i.test(f)) return "service";

  // Frontend layer
  if (/\/(hooks?|composables?|contexts?|providers?|signals?)\//i.test(f)) return "hook";
  if (/\/(components?|views?|pages?|screens?|layouts?|ui|widgets?|fragments?)\//i.test(f)) return "ui";
  if (isFrontend && /\/entities\//i.test(f)) return "ui";  // frontend "entities" = UI components

  // Events / messaging (event-driven architectures)
  if (/\/(events?|messages?|listeners?|subscribers?|publishers?)\//i.test(f)) return "service";

  return "other";
}

// Extract identifiers that look like function/method calls from a code body.
// Cross-language: matches camelCase, snake_case, PascalCase followed by `(`.
export function extractCallNames(code: string): Set<string> {
  const calls = new Set<string>();
  // foo(  /  Foo(  /  foo_bar(  /  $this->foo(  /  this.foo(  /  obj::foo(
  const re = /(?:^|[^a-zA-Z0-9_$])([a-zA-Z_][a-zA-Z0-9_]{2,})\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const name = m[1]!;
    // skip language keywords
    if (KEYWORDS_BLOCKLIST.has(name)) continue;
    calls.add(name);
  }
  return calls;
}

const KEYWORDS_BLOCKLIST = new Set([
  "if", "for", "while", "switch", "catch", "return", "new", "throw", "typeof",
  "function", "class", "const", "let", "var", "void", "async", "await", "yield",
  "isset", "empty", "is_null", "array", "echo", "print", "list",
  "print_r", "var_dump", "die", "exit", "sizeof", "count",
  "len", "range", "list", "tuple", "dict", "set", "str", "int", "float", "bool",
  "make", "len", "cap", "append", "panic", "recover", "go", "defer",
  "println", "printf", "fmt", "Println", "Printf", "Errorf",
  "require", "include", "use",
]);
