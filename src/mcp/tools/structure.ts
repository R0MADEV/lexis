// Architectural-shape tools — they cut across many files to answer
// questions about overall code structure:
//   • dead_code                  — symbols with no callers
//   • config_lookup              — where a config key is defined / consumed
//   • interface_implementations  — classes implementing an interface
//   • event_handlers             — dispatchers + listeners for an event
//   • impact_analysis            — blast-radius summary for a symbol

import * as fs from "fs";
import * as path from "path";
import { getSymbol, findReferences, suggestSimilar } from "../../core/searcher";
import { attributeReferences } from "../../core/import-resolver";
import { pathFilterMatches } from "../../core/path-match";
import { Index, Symbol as IndexedSymbol } from "../../core/indexer";
import { log } from "../runtime/jsonrpc";
import { runRg } from "../runtime/ripgrep";
import { detectLayer, formatSuggestions } from "../runtime/format";

export function execDeadCode(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const scope = args["path_filter"] as string | undefined;
  const limit = typeof args["limit"] === "number" ? Math.min(args["limit"], 100) : 30;

  log(`[dead_code] scope=${scope ?? "all"} limit=${limit}`);

  // Filter symbols by scope and skip noise (constructors, anonymous, very short names, magic methods)
  const SKIP_NAMES = new Set([
    "__construct", "constructor", "__init__", "main", "init", "render",
    "toString", "__toString", "equals", "hashCode", "compareTo", "Clone",
    "default", "index", "store", "show", "create", "update", "destroy",  // RESTful conventions
    "execute", "handle", "run", "process",  // common command/job entry points
    "new", "build", "make", "of", "from", "with",  // factories
    "get", "set", "is", "has",
  ]);

  let candidates = index.symbols.filter((s) => {
    if (s.name.length < 5) return false;
    if (SKIP_NAMES.has(s.name)) return false;
    if (s.name.startsWith("_")) return false;          // private convention in many langs
    if (s.name.startsWith("test")) return false;       // test functions are entry points
    if (s.type === "variable" || s.type === "unknown") return false;
    if (/[/_](test|spec)/i.test(s.file)) return false;  // test files don't count
    if (scope && !pathFilterMatches(s.file, scope)) return false;
    return true;
  });

  // Build name→count of definitions (skip names with multiple defs — interfaces/abstract)
  const defCount = new Map<string, number>();
  for (const s of index.symbols) defCount.set(s.name, (defCount.get(s.name) ?? 0) + 1);

  log(`[dead_code] checking ${candidates.length} candidates with ripgrep...`);

  // For each candidate, ripgrep its name across the project. If hits === 1, it's only its definition → dead.
  const dead: Array<{ s: IndexedSymbol; defs: number }> = [];
  const projectRoot = path.resolve(projectPath);

  // Cap how many we check (ripgrep per symbol is expensive)
  const checkCap = Math.min(candidates.length, 500);
  candidates = candidates.slice(0, checkCap);

  for (const s of candidates) {
    if (dead.length >= limit) break;

    const escName = s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rgArgs = [
      "--count-matches", "--no-heading",
      "-e", `\\b${escName}\\b`,
      "--glob", "!node_modules/**", "--glob", "!vendor/**",
      "--glob", "!.git/**", "--glob", "!dist/**", "--glob", "!build/**",
      projectPath,
    ];
    let stdout = runRg(rgArgs).stdout;

    let totalHits = 0;
    for (const line of stdout.split("\n")) {
      const m = line.match(/:(\d+)$/);
      if (m) totalHits += parseInt(m[1] ?? "0", 10);
    }

    // Heuristic: dead if total occurrences ≤ defCount (only its own definition(s))
    const numDefs = defCount.get(s.name) ?? 1;
    if (totalHits <= numDefs) {
      dead.push({ s, defs: numDefs });
    }
  }

  if (dead.length === 0) {
    return `No dead code candidates found${scope ? ` in "${scope}"` : ""} (checked ${checkCap} symbols).`;
  }

  const lines = dead.map(({ s }) => {
    return `  ${path.relative(projectRoot, s.file)}:${s.lineStart}  [${s.type}] ${s.name}`;
  });

  const note = checkCap < candidates.length
    ? `\n[Checked ${checkCap}/${candidates.length} candidates — increase scope filter to narrow]`
    : "";

  return `Dead code candidates (${dead.length})${scope ? ` in "${scope}"` : ""}:\n\n${lines.join("\n")}\n\n⚠️  Heuristic only — these symbols may still be used via DI, events, reflection, or external callers.${note}`;
}

export function execConfigLookup(
  args: Record<string, unknown>,
  projectPath: string
): string {
  const key = args["key"] as string;
  if (!key || key.length < 2) return "Error: 'key' must be at least 2 chars.";

  log(`[config_lookup] key="${key}"`);

  const keyEsc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // For nested keys like 'app.timeout', also try the last segment alone (timeout)
  const lastSeg = key.split(/[.\/]/).pop() ?? key;
  const lastSegEsc = lastSeg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // ── Definition patterns: where the key is SET ──
  const defPatterns = [
    // YAML / JSON / TOML — `key:` or `"key":` or `key =`
    `^\\s*['"]?${keyEsc}['"]?\\s*[:=]`,
    // .env style: KEY=value or KEY="value"
    `^\\s*${keyEsc}\\s*=`,
    // Last segment for nested keys (yaml indentation)
    `^\\s*${lastSegEsc}\\s*:`,
  ];
  // Restrict definitions to config file types
  const defGlobs = [
    "--glob", "*.{yaml,yml,json,toml,ini,env,conf,cfg,properties}",
    "--glob", ".env*",
    "--glob", "**/config/**",
    "--glob", "**/.env*",
  ];

  // ── Consumer patterns: where the key is READ ──
  const consumePatterns = [
    // PHP: env('KEY'), config('app.timeout'), getenv('KEY'), $_ENV['KEY']
    `env\\s*\\(\\s*['"\`]${keyEsc}['"\`]`,
    `getenv\\s*\\(\\s*['"\`]${keyEsc}['"\`]`,
    `config\\s*\\(\\s*['"\`]${keyEsc}['"\`]`,
    `\\$_ENV\\s*\\[\\s*['"\`]${keyEsc}['"\`]\\s*\\]`,
    // Symfony parameters: %key%
    `%${keyEsc}%`,
    // Python / Django: os.environ['X'], settings.X
    `os\\.environ(?:\\.get)?\\s*[\\(\\[]\\s*['"\`]${keyEsc}['"\`]`,
    `os\\.getenv\\s*\\(\\s*['"\`]${keyEsc}['"\`]`,
    // Node / TS: process.env.X, process.env['X']
    `process\\.env\\.${keyEsc}\\b`,
    `process\\.env\\s*\\[\\s*['"\`]${keyEsc}['"\`]\\s*\\]`,
    // Spring: @Value("${app.timeout}")
    `@Value\\s*\\(\\s*['"\`]\\$\\{${keyEsc}`,
    // Go: os.Getenv("X"), viper.Get*("X")
    `Getenv\\s*\\(\\s*['"\`]${keyEsc}['"\`]`,
    `viper\\.Get\\w*\\s*\\(\\s*['"\`]${keyEsc}['"\`]`,
    // Ruby: ENV['X'], Rails.application.credentials.X
    `ENV\\s*\\[\\s*['"\`]${keyEsc}['"\`]\\s*\\]`,
    `ENV\\.fetch\\s*\\(\\s*['"\`]${keyEsc}['"\`]`,
    // Go env struct tags (caarlos0/env, envconfig): \`env:"KEY"\` or \`envconfig:"KEY"\`
    `\\benv(?:config)?:"${keyEsc}(?:,[^"]*)?"`,
    // Pydantic BaseSettings: KEY: str = Field(env="KEY")
    `Field\\s*\\(\\s*[^)]*env\\s*=\\s*['"\`]${keyEsc}['"\`]`,
    // Zod env schema: KEY: z.string()  (when paired with declared key)
    `^\\s*${keyEsc}\\s*:\\s*z\\.`,
    // Generic: just the key as a string in code (broad fallback)
    `['"\`]${keyEsc}['"\`]`,
  ];
  const consumeGlobs = [
    "--glob", "!*.{yaml,yml,json,toml,ini,env,conf,cfg,properties,md,lock}",
    "--glob", "!node_modules/**", "--glob", "!vendor/**",
    "--glob", "!.git/**", "--glob", "!dist/**", "--glob", "!build/**",
  ];

  const searchPatterns = (patterns: string[], extraGlobs: string[]): string => {
    const args = [
      "--line-number", "--no-heading", "--max-filesize", "200K",
      "-e", patterns.join("|"),
      ...extraGlobs,
      projectPath,
    ];
    return runRg(args).stdout;
  };

  const definitions = searchPatterns(defPatterns, defGlobs);
  const consumers = searchPatterns(consumePatterns, consumeGlobs);

  const projectRoot = path.resolve(projectPath);
  const formatHits = (raw: string, max: number): { lines: string[]; total: number } => {
    const seen = new Set<string>();
    const out: string[] = [];
    let total = 0;
    for (const line of raw.split("\n")) {
      const m = line.match(/^(.+?):(\d+):(.*)$/);
      if (!m) continue;
      const [, file, lineStr, content] = m;
      const k = `${file}:${lineStr}`;
      if (seen.has(k)) continue;
      seen.add(k);
      total++;
      if (out.length < max) {
        out.push(`  ${path.relative(projectRoot, file ?? "")}:${lineStr}  ${(content ?? "").trim().slice(0, 130)}`);
      }
    }
    return { lines: out, total };
  };

  const defs = formatHits(definitions, 12);
  const cons = formatHits(consumers, 15);

  const sections: string[] = [`Config "${key}":`];

  if (defs.total > 0) {
    const more = defs.total > defs.lines.length ? ` (+${defs.total - defs.lines.length})` : "";
    sections.push(`DEFINED IN (${defs.total}${more}):\n${defs.lines.join("\n")}`);
  } else {
    sections.push(`DEFINED IN: not found in config files (may be set externally — env, k8s secret, CI variable)`);
  }

  if (cons.total > 0) {
    const more = cons.total > cons.lines.length ? ` (+${cons.total - cons.lines.length})` : "";
    sections.push(`CONSUMED BY (${cons.total}${more}):\n${cons.lines.join("\n")}`);
  } else {
    sections.push(`CONSUMED BY: no code reads this key — possibly dead config or read via dynamic key`);
  }

  return sections.join("\n\n");
}

export function execInterfaceImplementations(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const ifaceName = args["interface"] as string;
  if (!ifaceName) return "Error: 'interface' is required.";

  log(`[interface_implementations] iface="${ifaceName}"`);

  const ifaceEsc = ifaceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Cross-language patterns for "X implements/extends/inherits Iface"
  const patterns = [
    // PHP / Java / TS: implements Iface (handles multi-implements lists)
    `implements\\s+[\\w,\\s]*\\b${ifaceEsc}\\b`,
    // TS / Java / C#: extends AbstractClass
    `extends\\s+${ifaceEsc}\\b`,
    // Python: class X(Iface): or class X(A, Iface):
    `class\\s+\\w+\\s*\\([^)]*\\b${ifaceEsc}\\b[^)]*\\)\\s*:`,
    // Rust: impl Iface for X
    `impl\\s+${ifaceEsc}\\s+for\\s+\\w+`,
    // Go: doesn't have explicit "implements" — match struct with iface methods (skip, too noisy)
    // Kotlin: class X : Iface
    `class\\s+\\w+\\s*[:,]\\s*[^{]*\\b${ifaceEsc}\\b`,
    // C#: class X : Iface
    `:\\s*[^{,]*\\b${ifaceEsc}\\b`,
  ];

  const rgArgs = [
    "--line-number", "--no-heading", "--max-filesize", "200K",
    "-e", patterns.join("|"),
    "--glob", "!node_modules/**", "--glob", "!vendor/**",
    "--glob", "!.git/**", "--glob", "!dist/**", "--glob", "!build/**",
    "--glob", "!**/*.d.ts",
    projectPath,
  ];

  let stdout = runRg(rgArgs).stdout;

  if (!stdout.trim()) {
    return `No implementations found for "${ifaceName}". May not be an interface, or implementations live outside indexed paths.`;
  }

  const projectRoot = path.resolve(projectPath);
  const seen = new Set<string>();
  const impls: Array<{ file: string; line: number; className: string; layer: string }> = [];

  for (const line of stdout.split("\n")) {
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineStr, content] = m;
    const k = `${file}:${lineStr}`;
    if (seen.has(k)) continue;
    seen.add(k);

    // Extract the implementing class/struct name from the matched line
    const classMatch = (content ?? "").match(/(?:class|struct|impl)\s+(\w+)/);
    const className = classMatch?.[1] ?? "(unknown)";
    // Skip self-references (the interface declaring itself)
    if (className === ifaceName) continue;

    impls.push({
      file: file ?? "",
      line: parseInt(lineStr ?? "0", 10),
      className,
      layer: detectLayer(file ?? ""),
    });
  }

  if (impls.length === 0) {
    return `No implementations found for "${ifaceName}" (matched lines were self-references only).`;
  }

  // Group by layer for a quick architectural view
  const byLayer = new Map<string, typeof impls>();
  for (const i of impls) {
    if (!byLayer.has(i.layer)) byLayer.set(i.layer, []);
    byLayer.get(i.layer)!.push(i);
  }

  const sections: string[] = [`Interface "${ifaceName}" — ${impls.length} implementation(s):`];
  for (const [layer, list] of [...byLayer.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const top = list.slice(0, 8).map((i) => `  ${i.className.padEnd(40)} ${path.relative(projectRoot, i.file)}:${i.line}`);
    const more = list.length > top.length ? `\n  ... (+${list.length - top.length} more)` : "";
    sections.push(`[${layer.toUpperCase()}] (${list.length}):\n${top.join("\n")}${more}`);
  }

  return sections.join("\n\n");
}

export function execEventHandlers(
  args: Record<string, unknown>,
  projectPath: string
): string {
  const event = args["event"] as string;
  if (!event || event.length < 2) return "Error: 'event' must be at least 2 chars.";

  log(`[event_handlers] event="${event}"`);

  const eventEsc = event.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Patterns split into 'dispatch' (publishers) and 'handle' (subscribers/listeners)
  // Cross-framework: Symfony, Laravel, NestJS, Spring, Doctrine, EventEmitter, Rails, Django, RxJS
  const dispatchPatterns = [
    // Symfony / generic dispatch
    `->dispatch\\s*\\([^)]*['"\`]${eventEsc}`,
    // Laravel events
    `Event::dispatch\\s*\\([^)]*['"\`]${eventEsc}`,
    `event\\s*\\(\\s*new\\s+\\w*${eventEsc}`,
    // NestJS / EventEmitter
    `eventEmitter\\.emit\\s*\\([^)]*['"\`]${eventEsc}`,
    `\\.emit\\s*\\(\\s*['"\`]${eventEsc}`,
    `\\.publish\\s*\\(\\s*['"\`]${eventEsc}`,
    // Spring publishEvent
    `publishEvent\\s*\\([^)]*${eventEsc}`,
    // Django signals
    `${eventEsc}\\.send\\s*\\(`,
    `${eventEsc}\\.send_robust\\s*\\(`,
    // Rails ActiveSupport notifications
    `ActiveSupport::Notifications\\.instrument\\s*\\(\\s*['"\`]${eventEsc}`,
  ];

  const handlerPatterns = [
    // Symfony attributes
    `#\\[AsEventListener\\s*\\(\\s*['"\`]?${eventEsc}`,
    `#\\[AsMessageHandler`,  // generic message handler — match by symbol below
    // Symfony getSubscribedEvents
    `['"\`]${eventEsc}['"\`]\\s*=>`,
    // NestJS
    `@OnEvent\\s*\\(\\s*['"\`]${eventEsc}`,
    `@EventPattern\\s*\\(\\s*['"\`]${eventEsc}`,
    `@MessagePattern\\s*\\(\\s*['"\`]${eventEsc}`,
    // EventEmitter / EE3
    `\\.on\\s*\\(\\s*['"\`]${eventEsc}`,
    `\\.addListener\\s*\\(\\s*['"\`]${eventEsc}`,
    `\\.subscribe\\s*\\(\\s*['"\`]?${eventEsc}`,
    // Spring @EventListener
    `@EventListener\\s*\\(\\s*classes\\s*=\\s*${eventEsc}`,
    // Doctrine lifecycle
    `@PostPersist|@PrePersist|@PostUpdate|@PreUpdate|@PostRemove|@PreRemove`,
    // Django @receiver
    `@receiver\\s*\\(\\s*${eventEsc}`,
    // Rails callbacks
    `(after|before|around)_(save|create|update|destroy|commit|validation)\\s+:?\\w*${eventEsc}`,
  ];

  const allPatterns = [...dispatchPatterns, ...handlerPatterns];

  const rgArgs = [
    "--line-number", "--no-heading", "--max-filesize", "200K",
    "-e", allPatterns.join("|"),
    "--glob", "!node_modules/**", "--glob", "!vendor/**",
    "--glob", "!.git/**", "--glob", "!dist/**", "--glob", "!build/**",
    projectPath,
  ];

  let stdout = runRg(rgArgs).stdout;

  if (!stdout.trim()) return `No dispatchers or handlers found for event "${event}".`;

  // Classify each hit as dispatch vs handle
  const dispatchers: string[] = [];
  const handlers: string[] = [];
  const projectRoot = path.resolve(projectPath);
  const dispatchRe = new RegExp(dispatchPatterns.join("|"));

  const seen = new Set<string>();
  for (const line of stdout.split("\n").slice(0, 200)) {
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineStr, content] = m;
    const key = `${file}:${lineStr}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const rel = path.relative(projectRoot, file ?? "");
    const trimmed = (content ?? "").trim().slice(0, 130);
    const formatted = `  ${rel}:${lineStr}  ${trimmed}`;

    if (dispatchRe.test(content ?? "")) dispatchers.push(formatted);
    else handlers.push(formatted);
  }

  const sections: string[] = [`Event "${event}":`];
  if (dispatchers.length > 0) {
    const top = dispatchers.slice(0, 10);
    const more = dispatchers.length > top.length ? ` (+${dispatchers.length - top.length} more)` : "";
    sections.push(`DISPATCHED FROM (${dispatchers.length}${more}):\n${top.join("\n")}`);
  } else {
    sections.push(`DISPATCHED FROM: none found`);
  }
  if (handlers.length > 0) {
    const top = handlers.slice(0, 15);
    const more = handlers.length > top.length ? ` (+${handlers.length - top.length} more)` : "";
    sections.push(`HANDLED BY (${handlers.length}${more}):\n${top.join("\n")}`);
  } else {
    sections.push(`HANDLED BY: none found`);
  }

  return sections.join("\n\n");
}

export function execImpactAnalysis(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const symbolName = args["symbol"] as string;
  if (!symbolName) return "Error: 'symbol' is required.";
  const definedIn = args["defined_in"] as string | undefined;

  log(`[impact_analysis] symbol="${symbolName}" defined_in=${definedIn ?? "none"}`);

  const symInfo = getSymbol(symbolName, definedIn, index);
  if (!symInfo) {
    const sug = suggestSimilar(symbolName, index, 5);
    return `Symbol "${symbolName}" not found.${formatSuggestions(sug, path.resolve(projectPath))}`;
  }

  // Direct refs (depth=1)
  const allRefs = findReferences(symbolName, projectPath, index);
  const projectRoot = path.resolve(projectPath);

  // Several definitions share this name, so the raw reference list mixes them.
  // With defined_in, keep only what binds to the chosen one; without it, say so
  // rather than presenting a blast radius that silently sums unrelated symbols.
  const definitions = [...new Set(index.symbols.filter((s) => s.name === symbolName).map((s) => s.file))];
  let ambiguityNote: string | null = null;
  let refs = allRefs;

  if (definitions.length > 1) {
    const contents = new Map<string, string>();
    const readFile = (f: string): string => {
      if (!contents.has(f)) {
        try { contents.set(f, fs.readFileSync(f, "utf-8")); }
        catch { contents.set(f, ""); }
      }
      return contents.get(f)!;
    };
    const { byDefinition, unattributed } = attributeReferences(allRefs, symbolName, definitions, readFile);

    if (definedIn) {
      refs = byDefinition.get(symInfo.symbol.file) ?? [];
      if (unattributed.length > 0) {
        ambiguityNote = `NOTE: ${unattributed.length} reference(s) could not be bound to any definition and are excluded from these numbers.`;
      }
    } else {
      const list = definitions.map((d) => `  ${path.relative(projectRoot, d)}`).join("\n");
      ambiguityNote =
        `⚠️  AMBIGUOUS: ${definitions.length} definitions share the name "${symbolName}", ` +
        `so the numbers below merge all of them. Pass defined_in to scope to one:\n${list}`;
    }
  }

  const calls = refs.filter((r) => r.kind === "call");
  const types = refs.filter((r) => r.kind === "type" || r.kind === "other");
  const imports = refs.filter((r) => r.kind === "import");

  // Group callers by file + bucket by layer
  const callerFiles = new Map<string, number>();
  for (const r of calls) {
    callerFiles.set(r.file, (callerFiles.get(r.file) ?? 0) + 1);
  }

  // Layer breakdown
  const byLayer = new Map<string, Set<string>>();
  for (const r of [...calls, ...types]) {
    const layer = detectLayer(r.file);
    if (!byLayer.has(layer)) byLayer.set(layer, new Set());
    byLayer.get(layer)!.add(r.file);
  }

  // Test coverage proxy: how many caller files are tests?
  const testFiles = [...callerFiles.keys()].filter((f) => /\b(test|spec|cypress|__tests__)\b/i.test(f));

  // Risk heuristic
  const riskScore = calls.length + types.length * 0.5 + (callerFiles.size > 10 ? 5 : 0);
  const riskLevel =
    riskScore < 5  ? "LOW"    :
    riskScore < 20 ? "MEDIUM" :
    riskScore < 50 ? "HIGH"   : "CRITICAL";

  const sections: string[] = [];
  if (ambiguityNote) sections.push(ambiguityNote);
  sections.push(
    `IMPACT ANALYSIS: ${symbolName} [${symInfo.symbol.type}]`,
    `  ${path.relative(projectRoot, symInfo.symbol.file)}:${symInfo.symbol.lineStart}`,
    `  Risk: ${riskLevel} (${calls.length} direct calls, ${types.length} type/DI refs, ${imports.length} imports across ${callerFiles.size} files)`,
  );

  if (byLayer.size > 0) {
    const layerLines = [...byLayer.entries()]
      .sort((a, b) => b[1].size - a[1].size)
      .map(([layer, files]) => `  ${layer.padEnd(12)} ${files.size} file${files.size === 1 ? "" : "s"}`);
    sections.push(`AFFECTED LAYERS:\n${layerLines.join("\n")}`);
  }

  if (testFiles.length > 0) {
    const top = testFiles.slice(0, 5).map((f) => `  ${path.relative(projectRoot, f)}`);
    sections.push(`TEST COVERAGE: ${testFiles.length} test file(s) reference this symbol\n${top.join("\n")}`);
  } else {
    sections.push(`TEST COVERAGE: ⚠️  no tests reference this symbol — refactor at your own risk`);
  }

  // Top callers (most refs to this symbol)
  if (callerFiles.size > 0) {
    const topCallers = [...callerFiles.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([file, count]) => `  ${path.relative(projectRoot, file)}  (${count} ref${count === 1 ? "" : "s"})`);
    sections.push(`TOP CALLERS:\n${topCallers.join("\n")}`);
  }

  return sections.join("\n\n");
}
