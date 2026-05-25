// Code-flow tools: call_chain (BFS path between two symbols) and
// list_entrypoints (classify files by route/cli/server/event/job).

import * as path from "path";
import { getSymbol, suggestSimilar } from "../../core/searcher";
import { Index, Symbol as IndexedSymbol } from "../../core/indexer";
import { log } from "../runtime/jsonrpc";
import { extractCallNames, formatSuggestions } from "../runtime/format";

export function execCallChain(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const from = args["from"] as string;
  const to   = args["to"]   as string;
  const maxDepth = Math.min(typeof args["max_depth"] === "number" ? args["max_depth"] : 5, 8);

  log(`[call_chain] ${from} → ${to} (max_depth=${maxDepth})`);

  if (!from || !to) return "Error: 'from' and 'to' are required.";

  // Verify both endpoints exist in the index
  const fromSym = getSymbol(from, undefined, index);
  if (!fromSym) {
    const sug = suggestSimilar(from, index, 3);
    return `Source symbol "${from}" not found.${formatSuggestions(sug, path.resolve(projectPath))}`;
  }
  const toExists = index.symbols.some((s) => s.name === to);
  if (!toExists) {
    const sug = suggestSimilar(to, index, 3);
    return `Target symbol "${to}" not found.${formatSuggestions(sug, path.resolve(projectPath))}`;
  }

  // BFS on the call graph. Path = list of symbol names.
  type Step = { name: string; path: string[] };
  const visited = new Set<string>([from]);
  const queue: Step[] = [{ name: from, path: [from] }];

  while (queue.length > 0) {
    const step = queue.shift()!;
    if (step.path.length > maxDepth) continue;

    // Resolve current symbol's body (use cache via index lookup + read)
    const sym = getSymbol(step.name, undefined, index);
    if (!sym) continue;

    const callNames = extractCallNames(sym.body);

    if (callNames.has(to)) {
      const fullPath = [...step.path, to];
      return formatChain(fullPath, index, projectPath);
    }

    for (const callee of callNames) {
      if (visited.has(callee)) continue;
      // Only traverse names we know about (must be indexed)
      if (!index.symbols.some((s) => s.name === callee)) continue;
      visited.add(callee);
      queue.push({ name: callee, path: [...step.path, callee] });
    }
  }

  return `No call path found from "${from}" to "${to}" within ${maxDepth} hops.\nExplored ${visited.size} symbol(s). Try a higher max_depth or check that callers reach the target via dynamic dispatch (events, DI, reflection).`;
}

function formatChain(chain: string[], index: Index, projectPath: string): string {
  const projectRoot = path.resolve(projectPath);
  const lines: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const name = chain[i]!;
    const sym = index.symbols.find((s) => s.name === name);
    const arrow = i === 0 ? "  " : "→ ";
    if (sym) {
      const rel = path.relative(projectRoot, sym.file);
      lines.push(`${arrow}${name}  [${sym.type}]  ${rel}:${sym.lineStart}`);
    } else {
      lines.push(`${arrow}${name}`);
    }
  }
  return `Call chain (${chain.length - 1} hop${chain.length - 1 === 1 ? "" : "s"}):\n\n${lines.join("\n")}`;
}

type EntryKind = "route" | "cli" | "server" | "event" | "job";

function classifyEntry(filePath: string): EntryKind | null {
  const f = filePath.replace(/\\/g, "/");
  const base = path.basename(f);

  // Skip frontend routing conventions that look like server entries but aren't.
  // Any TS/JS file inside pages/, views/, routes/, screens/ — covers Next.js, Nuxt,
  // SvelteKit, Remix, React Router, Vue Router, Expo, etc.
  const isFrontendRoute = /\/(pages?|views?|routes?|screens?)\/.+\.(t|j)sx?$/i.test(f);
  if (isFrontendRoute) return null;

  // Server entry files (long-running daemons / web servers)
  // Restricted to Go/Python/Rust/Ruby/PHP/Java/Kotlin where `index.X` actually means entry
  if (/^(main|server|app|wsgi|asgi|application)\.(go|py|rs|rb|php|java|kt)$/i.test(base)) return "server";
  if (/^index\.(go|py|rs|php)$/i.test(base)) return "server";
  // TS/JS server entry: only when the file lives at project root or under src/cli/cmd/bin
  if (/^(main|server|app|index)\.(ts|js)$/i.test(base)) {
    const dir = path.dirname(f);
    const isShallow = /(?:^|\/)(src|cli|cmd|bin|server)\/[^/]+$/i.test(dir) || /^[^/]+$/i.test(dir);
    if (isShallow) return "server";
  }
  if (/\/(cmd|bin|server)\/[^/]+\/main\.(go|py|rs)$/i.test(f)) return "server";
  if (/^manage\.py$/i.test(base)) return "server";  // Django

  // CLI tools — nested bin/scripts/cli, console artisan, makefile-driven
  if (/\/(cli|bin|scripts?|tools?)\//i.test(f) && !/(node_modules|vendor)/.test(f)) return "cli";
  if (/^(console|artisan|gradlew|mvnw)$/i.test(base)) return "cli";
  if (/cli\.(go|py|rs|ts|js|rb)$/i.test(base)) return "cli";

  // HTTP routes / URL maps
  if (/\b(routes?|router|routing|urls?)\.(go|py|rs|ts|js|rb|php)$/i.test(base)) return "route";
  if (/\/(routes?|router|routing)\//i.test(f)) return "route";
  if (/urls\.py$/i.test(base)) return "route";  // Django

  // Controllers & API actions
  if (/\/(controllers?|handlers?|actions?|resolvers?)\//i.test(f)) return "route";
  if (/(controller|handler|action|resolver)\.[a-z]+$/i.test(base)) return "route";

  // Event handlers / subscribers / listeners
  if (/\/(listeners?|subscribers?|consumers?|observers?)\//i.test(f)) return "event";
  if (/(listener|subscriber|consumer|observer)\.[a-z]+$/i.test(base)) return "event";

  // Scheduled jobs / cron / workers
  if (/\/(jobs?|tasks?|workers?|schedules?|crons?)\//i.test(f)) return "job";
  if (/(job|task|worker|cron|scheduler)\.[a-z]+$/i.test(base)) return "job";

  return null;
}

export function execListEntrypoints(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const filterKind = args["kind"] as EntryKind | undefined;

  log(`[list_entrypoints] kind=${filterKind ?? "all"}`);

  const projectRoot = path.resolve(projectPath);
  const buckets: Record<EntryKind, Map<string, IndexedSymbol[]>> = {
    route: new Map(), cli: new Map(), server: new Map(), event: new Map(), job: new Map(),
  };

  // 1. Classify every indexed file
  const fileKind = new Map<string, EntryKind>();
  for (const file of index.files) {
    const k = classifyEntry(file);
    if (k && (!filterKind || k === filterKind)) {
      fileKind.set(file, k);
      buckets[k].set(file, []);
    }
  }

  // 2. Attach symbols to their files
  for (const sym of index.symbols) {
    const k = fileKind.get(sym.file);
    if (!k) continue;
    buckets[k].get(sym.file)!.push(sym);
  }

  // 3. Format
  const labels: Record<EntryKind, string> = {
    server: "SERVERS / DAEMONS", cli: "CLI COMMANDS",
    route: "HTTP ROUTES / CONTROLLERS", event: "EVENT HANDLERS", job: "SCHEDULED JOBS",
  };
  const order: EntryKind[] = ["server", "route", "event", "job", "cli"];

  const sections: string[] = [];
  let totalFiles = 0;

  for (const k of order) {
    if (filterKind && k !== filterKind) continue;
    const bucket = buckets[k];
    if (bucket.size === 0) continue;

    // Sort files: most symbols first, then path
    const sorted = [...bucket.entries()]
      .map(([file, syms]) => ({ file, syms, count: syms.length }))
      .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
      .slice(0, 12);

    const lines = sorted.map(({ file, syms, count }) => {
      const rel = path.relative(projectRoot, file);
      const top = syms.slice(0, 3).map((s) => s.name).join(", ");
      const more = count > 3 ? ` +${count - 3}` : "";
      const summary = count > 0 ? `  → ${top}${more}` : "";
      return `  ${rel}${summary}`;
    });
    const overflow = bucket.size - sorted.length;
    const head = `${labels[k]} (${bucket.size}${overflow > 0 ? `, top ${sorted.length}` : ""}):`;
    sections.push(`${head}\n${lines.join("\n")}`);
    totalFiles += bucket.size;
  }

  if (sections.length === 0) {
    return filterKind
      ? `No entrypoints of kind "${filterKind}" detected.`
      : "No entrypoints detected. This may not be a service/app project, or files use uncommon naming.";
  }

  return `Entry points overview (${totalFiles} files):\n\n${sections.join("\n\n")}`;
}
