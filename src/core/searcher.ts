import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Index, Symbol } from "./indexer";
import { detectContext } from "./language-detector";
import {
  AnalyzedQuery,
  QueryIntent,
  analyzeQuery,
  extractTechnicalTerms,
  isDefinitionMatch,
} from "./query-analyzer";

export interface SearchResult {
  symbol: Symbol;
  code: string;
  score: number;
}

export function search(
  query: string,
  index: Index,
  projectPath: string,
  topK: number = 5,
  depth: number = 2,
  intentOverride?: QueryIntent
): SearchResult[] {
  const debug = process.env["LEXIS_DEBUG"] === "true";
  let analyzed = analyzeQuery(query);
  if (intentOverride) analyzed = { ...analyzed, intent: intentOverride };
  if (debug) {
    console.log(`  [query] intent=${analyzed.intent}${intentOverride ? " (override)" : ""} mainTerm="${analyzed.mainTerm}"`);
    console.log(`  [query] terms: ${analyzed.terms.join(", ")}`);
  }

  const ripgrepResults = searchByRipgrep(query, projectPath, analyzed.terms);
  // Fix 3: skip [unknown] filename results for files already covered by typed ripgrep results
  const typedFiles = new Set(ripgrepResults.map((r) => r.symbol.file));
  const filenameResults = searchFilenames(analyzed.filenameTerms, index, projectPath, typedFiles);
  const initial = filterByDominantLayer(dedup([...ripgrepResults, ...filenameResults]));

  if (initial.length === 0) {
    return fallbackSymbolSearch(query, index, topK);
  }

  // reverse lookup: find who calls the symbols we found
  const callers = searchCallers(initial, projectPath, analyzed.terms, debug);

  // type resolution: find interface/type/struct definitions used in results
  const typeDefs = searchTypeDefinitions(initial, projectPath, debug);

  // test correlation: find test files related to the initial results
  const tests = searchRelatedTests(initial, projectPath, debug);

  const allInitial = dedup([...initial, ...callers, ...typeDefs, ...tests]);

  // mark direct matches so they survive the final cap (they are the most relevant for the user)
  const directFiles = new Set(allInitial.map((r) => r.symbol.file));
  const all = traverseGraph(allInitial, projectPath, depth, debug, analyzed.terms);

  // apply intent-based scoring boost
  const boosted = applyIntentBoost(all, analyzed);
  // dedup overlaps, then merge adjacent chunks from the same file (reduces token waste)
  const deduped = mergeAdjacent(dedup(boosted)).sort((a, b) => b.score - a.score);

  const direct = deduped.filter((r) => directFiles.has(r.symbol.file));
  const traversed = deduped.filter((r) => !directFiles.has(r.symbol.file));

  // enrich method chunks with their class header + imports (only direct matches to limit cost)
  const directEnriched = enrichWithClassContext(direct);

  // override via LEXIS_MAX_RESULTS env var (caps total output)
  const envCap = parseInt(process.env["LEXIS_MAX_RESULTS"] ?? "0");
  // Fix 4: scale result breadth for large indexes (>20k symbols = large project)
  const idxScale = index.symbols.length > 20000 ? 1.5 : index.symbols.length > 5000 ? 1.2 : 1;
  const totalCap = envCap > 0
    ? envCap
    : Math.round((depth > 0 ? Math.max(topK * 10, 60) : topK) * idxScale);

  // direct matches always pass; traversal results fill remaining slots
  const remaining = Math.max(0, totalCap - directEnriched.length);
  const combined = [...directEnriched, ...traversed.slice(0, remaining)];

  // Apply directory-level diversification only when we have many results from few areas
  // (otherwise it's a noop). Goal: replace 10x UserController hits with a mix of
  // UserController, UserService, UserRepository, etc.
  return diversifyByDirectory(combined);
}

// Round-robin across top-level directories so users see variety, not just the loudest folder.
// Preserves overall score order within each directory bucket.
function diversifyByDirectory(results: SearchResult[]): SearchResult[] {
  if (results.length <= 6) return results;

  const buckets = new Map<string, SearchResult[]>();
  for (const r of results) {
    // group by 2 path segments (eg. 'src/controllers') — granular enough to separate layers
    const parts = r.symbol.file.replace(/\\/g, "/").split("/");
    const idx = Math.max(0, parts.length - 3);  // last dir before file
    const key = parts.slice(idx, idx + 2).join("/");
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(r);
  }
  // Cheap guard: if everything ended up in 1-2 buckets, no diversification needed
  if (buckets.size <= 2) return results;

  // Round-robin pick: top-of-each-bucket per pass, until exhausted
  const out: SearchResult[] = [];
  const queues = [...buckets.values()];
  while (out.length < results.length) {
    let progressed = false;
    for (const q of queues) {
      if (q.length > 0) {
        out.push(q.shift()!);
        progressed = true;
        if (out.length >= results.length) break;
      }
    }
    if (!progressed) break;
  }
  return out;
}

const ERROR_HANDLING_PATTERN = /\b(catch|throw(?:s|ing)?\b|try\s*\{|\.catch\s*\(|reject\s*\(|Promise\.reject|raise\s|except\s|rescue\s|panic\s*\(|\.unwrap\(\)|Result<|Option<)\b/;

function applyIntentBoost(results: SearchResult[], analyzed: AnalyzedQuery): SearchResult[] {
  if (analyzed.intent === "general" || !analyzed.mainTerm) return results;

  return results.map((r) => {
    const isDef = isDefinitionMatch(r.code, analyzed.mainTerm);
    const hasErrorHandling = ERROR_HANDLING_PATTERN.test(r.code);
    const isTest = /[._-](test|spec)\.[a-z]+$|__tests?__\//.test(r.symbol.file);
    let bonus = 0;
    if (analyzed.intent === "definition" && isDef) bonus = 3;
    else if (analyzed.intent === "usage" && !isDef) bonus = 1;
    else if (analyzed.intent === "flow" && isDef) bonus = 1.5;
    else if (analyzed.intent === "bug") {
      if (!isDef) bonus += 3;
      if (hasErrorHandling) bonus += 2;
      if (isTest) bonus += 1.5;
    }
    return bonus === 0 ? r : { ...r, score: r.score + bonus };
  });
}

// Fix 1: detect file-header boilerplate that produces noisy [unknown] results
const FILE_HEADER_RE = /^\s*(?:<\?(?:php|xml)|package\s+\w|#!\/|#\s*frozen_string_literal|["']use\s+strict["']|#include\s+[<"])/;

function searchFilenames(
  terms: string[],
  index: Index,
  projectPath: string,
  excludeFiles?: Set<string>  // Fix 3: skip files already covered by typed ripgrep results
): SearchResult[] {
  if (terms.length === 0) return [];
  const results: SearchResult[] = [];
  const lowerTerms = terms.map((t) => t.toLowerCase());

  for (const file of index.files) {
    if (excludeFiles?.has(file)) continue;  // Fix 3

    const basename = path.basename(file).toLowerCase();
    const matchCount = lowerTerms.filter((t) => basename.includes(t)).length;
    if (matchCount === 0) continue;

    const { code, lineStart, lineEnd } = extractFunction(file, 1);
    const truncated = truncateLongLines(code);

    // Fix 1: file-header boilerplate (<?php, package, shebang…) scores low
    const firstLine = truncated.split("\n").find((l) => l.trim().length > 0) ?? "";
    const isBoilerplate = FILE_HEADER_RE.test(firstLine);

    results.push({
      symbol: {
        name: extractFunctionName(truncated) ?? path.basename(file, path.extname(file)),
        file,
        lineStart,
        lineEnd,
        type: "unknown",
      },
      code: truncated,
      score: isBoilerplate ? 0.5 : matchCount * 2 + 1,
    });
  }

  // limit to top 10 by score to avoid flooding when terms are too generic
  return results.sort((a, b) => b.score - a.score).slice(0, 10);
}

function traverseGraph(
  initial: SearchResult[],
  projectPath: string,
  depth: number,
  debug: boolean = false,
  originalTerms: string[] = []
): SearchResult[] {
  const deduped = dedup(initial);
  const visitedFiles = new Set<string>(deduped.map((r) => r.symbol.file));
  // keep ALL initial results; only limit the frontier we expand
  const all: SearchResult[] = [...deduped];
  let frontier = deduped.slice(0, 8);
  const fileCache = new Map<string, string>();

  for (let d = 0; d < depth; d++) {
    const nextFrontier: SearchResult[] = [];

    for (const result of frontier) {
      const refs = extractReferences(result.code, result.symbol.file, fileCache);
      if (debug) console.log(`  [traversal d=${d+1}] ${result.symbol.file} → refs: ${refs.join(", ")}`);

      for (const ref of refs) {
        const found = searchByRipgrep(ref, projectPath);

        for (const r of found) {
          if (visitedFiles.has(r.symbol.file)) continue;

          if (!isConnected(result.symbol.file, r.symbol.file, ref, fileCache)) continue;

          visitedFiles.add(r.symbol.file);
          if (originalTerms.length > 0) {
            r.score = originalTerms.filter((t) => r.code.includes(t)).length;
            if (r.score === 0) continue;
          }
          nextFrontier.push(r);
          all.push(r);
        }
      }
    }

    if (debug) console.log(`  [traversal d=${d+1}] found ${nextFrontier.length} new files`);
    if (nextFrontier.length === 0) break;
    frontier = dedup(nextFrontier).slice(0, 8);
  }

  return all;
}

const GENERIC_NAMES = new Set([
  "get", "set", "run", "do", "fn", "go", "new", "use", "log",
  "init", "call", "exec", "next", "then", "done", "pass",
  "save", "find", "load", "send", "read", "write", "open", "close",
  "create", "update", "delete", "fetch", "handle", "process",
  "start", "stop", "reset", "clear", "check", "build",
]);

function searchCallers(
  initial: SearchResult[],
  projectPath: string,
  originalTerms: string[],
  debug: boolean = false
): SearchResult[] {
  const definitionFiles = new Set(initial.map((r) => r.symbol.file));
  const callers: SearchResult[] = [];

  for (const result of initial.slice(0, 3)) {
    const name = result.symbol.name;
    if (name.length < 4 || GENERIC_NAMES.has(name.toLowerCase())) continue;
    const found = searchByRipgrep(name, projectPath);

    for (const r of found) {
      if (definitionFiles.has(r.symbol.file)) continue;

      if (originalTerms.length > 0) {
        r.score = originalTerms.filter((t) => r.code.includes(t)).length;
        if (r.score === 0) continue;
      }

      callers.push(r);
    }
  }

  if (debug && callers.length > 0) {
    console.log(`  [reverse lookup] found ${callers.length} caller(s): ${[...new Set(callers.map(c => c.symbol.file))].join(", ")}`);
  }

  return dedup(callers);
}

function extractTypeReferences(code: string): string[] {
  const primitives = new Set([
    // TypeScript / JavaScript
    "string", "number", "boolean", "void", "null", "undefined", "any", "never",
    "object", "unknown", "bigint", "symbol",
    "Promise", "Record", "Partial", "Required", "Readonly", "Pick", "Omit", "Array", "Map", "Set",
    // Python
    "int", "float", "str", "bool", "dict", "list", "tuple", "bytes", "None",
    // Go / Rust / C
    "i8", "i16", "i32", "i64", "i128", "u8", "u16", "u32", "u64", "u128", "f32", "f64", "usize", "isize",
    "char", "byte", "rune", "error",
    // Java / Kotlin
    "String", "Integer", "Long", "Double", "Float", "Boolean", "Object", "Void",
    "List", "Map", "Set", "Collection", "Iterator",
  ]);

  const types = new Set<string>();

  // TypeScript / Rust: : TypeName
  for (const m of code.matchAll(/:\s*([A-Z][a-zA-Z0-9]+)(?:<|>|\[|\s|,|\))?/g)) {
    const t = m[1];
    if (t && !primitives.has(t)) types.add(t);
  }

  // extends / implements (TS, Java, Kotlin, PHP)
  for (const m of code.matchAll(/(?:extends|implements)\s+([A-Z][a-zA-Z0-9]+)/g)) {
    const t = m[1];
    if (t && !primitives.has(t)) types.add(t);
  }

  // Generics: Array<TypeName>, Optional<TypeName>, List<TypeName>
  for (const m of code.matchAll(/<([A-Z][a-zA-Z0-9]+)>/g)) {
    const t = m[1];
    if (t && !primitives.has(t)) types.add(t);
  }

  // Java / Go / C style params: (TypeName varName) or (TypeName, TypeName)
  for (const m of code.matchAll(/\(\s*([A-Z][a-zA-Z0-9]+)\s+[a-z$_]/g)) {
    const t = m[1];
    if (t && !primitives.has(t)) types.add(t);
  }

  // PHP style params: (TypeName $varName)
  for (const m of code.matchAll(/\(([A-Z][a-zA-Z0-9\\]+)\s+\$/g)) {
    const t = m[1]?.split("\\").pop();
    if (t && !primitives.has(t)) types.add(t);
  }

  // Python type hints: def foo(x: TypeName) — already caught by `: TypeName`
  // Ruby / dynamic langs won't have static types — nothing to extract

  return [...types].slice(0, 5);
}

function isTypeDefinition(code: string, typeName: string): boolean {
  const escaped = typeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    // TypeScript / Java / Kotlin / PHP
    new RegExp(`interface\\s+${escaped}\\b`).test(code) ||
    new RegExp(`type\\s+${escaped}\\s*[=<{]`).test(code) ||
    new RegExp(`class\\s+${escaped}\\b`).test(code) ||
    new RegExp(`abstract\\s+class\\s+${escaped}\\b`).test(code) ||
    // Go / Rust / C
    new RegExp(`struct\\s+${escaped}\\b`).test(code) ||
    new RegExp(`type\\s+${escaped}\\s+struct`).test(code) ||
    // Enums (all languages)
    new RegExp(`enum\\s+${escaped}\\b`).test(code) ||
    // Python dataclass / NamedTuple
    new RegExp(`class\\s+${escaped}\\s*[:(]`).test(code) ||
    // Rust trait
    new RegExp(`trait\\s+${escaped}\\b`).test(code) ||
    // Java / Kotlin annotation
    new RegExp(`@interface\\s+${escaped}\\b`).test(code)
  );
}

function searchTypeDefinitions(
  initial: SearchResult[],
  projectPath: string,
  debug: boolean = false
): SearchResult[] {
  const definitionFiles = new Set(initial.map((r) => r.symbol.file));
  const searchedTypes = new Set<string>();
  const typeResults: SearchResult[] = [];

  for (const result of initial.slice(0, 3)) {
    for (const typeName of extractTypeReferences(result.code)) {
      if (typeName.length < 4 || GENERIC_NAMES.has(typeName.toLowerCase())) continue;
      if (searchedTypes.has(typeName)) continue;
      searchedTypes.add(typeName);

      const found = searchByRipgrep(typeName, projectPath);
      for (const r of found) {
        if (definitionFiles.has(r.symbol.file)) continue;
        if (!isTypeDefinition(r.code, typeName)) continue;
        typeResults.push(r);
      }
    }
  }

  if (debug && typeResults.length > 0) {
    console.log(`  [type resolution] found ${typeResults.length} type definition(s): ${[...searchedTypes].join(", ")}`);
  }

  return dedup(typeResults);
}

function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    /\.(test|spec)\.[a-z]+$/.test(normalized) ||       // JS/TS: foo.test.ts, foo.spec.ts
    /_test\.[a-z]+$/.test(normalized) ||                // Go: foo_test.go
    /\/test_[^/]+\.[a-z]+$/.test(normalized) ||         // Python: test_foo.py
    /Test\.[a-z]+$/.test(normalized) ||                 // Java/PHP: FooTest.java, FooTest.php
    /_spec\.[a-z]+$/.test(normalized) ||                // Ruby: foo_spec.rb
    normalized.includes("/__tests__/") ||
    /\/tests?\//.test(normalized) ||
    /\/spec\//.test(normalized)                         // Ruby/RSpec spec/ dir
  );
}

function readTestFile(filePath: string): SearchResult | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const base = path.basename(filePath, path.extname(filePath));
    return {
      symbol: {
        name: base,
        file: filePath,
        lineStart: 1,
        lineEnd: Math.min(60, lines.length),
        type: "function",
      },
      code: lines.slice(0, 60).join("\n"),
      score: 1,
    };
  } catch {
    return null;
  }
}

function searchRelatedTests(
  initial: SearchResult[],
  projectPath: string,
  debug: boolean = false
): SearchResult[] {
  const testResults: SearchResult[] = [];
  const seenFiles = new Set<string>(initial.map((r) => r.symbol.file));

  for (const result of initial.slice(0, 3)) {
    const filePath = result.symbol.file;
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));
    const ext = path.extname(filePath);

    // 1. name-based: look for co-located test files across all languages
    const capitalized = base.charAt(0).toUpperCase() + base.slice(1);
    const candidates = [
      // JS / TS
      path.join(dir, `${base}.test${ext}`),
      path.join(dir, `${base}.spec${ext}`),
      path.join(dir, `${base}.test.ts`),
      path.join(dir, `${base}.spec.ts`),
      path.join(dir, "__tests__", `${base}${ext}`),
      path.join(dir, "__tests__", `${base}.test${ext}`),
      // Go: session_test.go
      path.join(dir, `${base}_test.go`),
      // Python: test_session.py (same dir or tests/ sibling)
      path.join(dir, `test_${base}.py`),
      path.join(path.dirname(dir), "tests", `test_${base}.py`),
      // PHP / Java: SessionTest.php, SessionTest.java
      path.join(dir, `${capitalized}Test${ext}`),
      path.join(dir, `${capitalized}Test.php`),
      path.join(dir, `${capitalized}Test.java`),
      // Ruby: session_spec.rb, session_test.rb
      path.join(dir, `${base}_spec.rb`),
      path.join(dir, `${base}_test.rb`),
      path.join(path.dirname(dir), "spec", `${base}_spec.rb`),
      // Kotlin
      path.join(dir, `${capitalized}Test.kt`),
    ];

    for (const testFile of candidates) {
      if (seenFiles.has(testFile)) continue;
      try { fs.accessSync(testFile); } catch { continue; }
      seenFiles.add(testFile);
      const r = readTestFile(testFile);
      if (r) testResults.push(r);
    }

    // 2. content-based: find test files that mention the symbol name
    const symbolResults = searchByRipgrep(result.symbol.name, projectPath);
    for (const r of symbolResults) {
      if (seenFiles.has(r.symbol.file)) continue;
      if (!isTestFile(r.symbol.file)) continue;
      seenFiles.add(r.symbol.file);
      testResults.push(r);
    }
  }

  if (debug && testResults.length > 0) {
    console.log(`  [test correlation] found ${testResults.length} test file(s): ${testResults.map((r) => r.symbol.file).join(", ")}`);
  }

  return testResults;
}

const LAYER_BY_EXT: Record<string, string> = {
  // Frontend
  ".ts": "frontend", ".tsx": "frontend", ".js": "frontend", ".jsx": "frontend",
  ".mjs": "frontend", ".cjs": "frontend",
  ".vue": "frontend", ".svelte": "frontend",
  ".dart": "frontend",        // Flutter UI layer
  // Backend
  ".go": "backend", ".py": "backend", ".rb": "backend",
  ".java": "backend", ".kt": "backend", ".kts": "backend",
  ".cs": "backend", ".php": "backend",
  ".rs": "backend", ".cpp": "backend", ".cc": "backend", ".c": "backend",
  ".swift": "backend",        // Swift can be both but default to backend (server-side)
  ".scala": "backend",
  ".ex": "backend", ".exs": "backend",
};

const CROSS_LAYER_PATTERNS = [
  // JS / TS
  /fetch\(['"`]/, /axios\.(get|post|put|delete|patch)/,
  /\$http\.(get|post|put|delete)/, /http\.(get|post|put|delete)/,
  // Python
  /requests\.(get|post|put|delete|patch)/, /httpx\.(get|post|put|delete)/,
  /urllib\.request/, /aiohttp\.ClientSession/,
  // Ruby
  /Net::HTTP|HTTParty|Faraday|RestClient|Typhoeus/,
  // Go
  /http\.Get\s*\(|http\.Post\s*\(|http\.NewRequest/,
  // Java / Kotlin
  /RestTemplate|WebClient|HttpClient|OkHttpClient|Retrofit/,
  // PHP
  /curl_exec|GuzzleHttp|Http::|file_get_contents\s*\(\s*['"`]http/,
  // Rust
  /reqwest::|ureq::|hyper::/,
  // C# / .NET
  /HttpClient|RestSharp|WebRequest/,
  // WebSocket (all languages)
  /socket\.(emit|on|send)/, /websocket/i, /ws\.(send|on)/,
  /ActionCable|Phoenix\.Socket|django_channels/,
  // Named endpoints or routes
  /['"`]\/api\//, /['"`]\/ws\//, /['"`]\/socket\//,
  /['"`]https?:\/\//,
];

function filterByDominantLayer(results: SearchResult[]): SearchResult[] {
  if (results.length === 0) return results;

  const layerCount: Record<string, number> = {};
  for (const r of results) {
    const ext = path.extname(r.symbol.file).toLowerCase();
    const layer = LAYER_BY_EXT[ext] ?? "unknown";
    layerCount[layer] = (layerCount[layer] ?? 0) + r.score;
  }

  const dominant = Object.entries(layerCount).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!dominant || dominant === "unknown") return results;

  return results.filter((r) => {
    const ext = path.extname(r.symbol.file).toLowerCase();
    const layer = LAYER_BY_EXT[ext] ?? "unknown";
    if (layer === "unknown" || layer === dominant) return true;
    // keep cross-layer only if high score
    return r.score >= 2;
  });
}

function isConnected(
  originFile: string,
  targetFile: string,
  _ref: string,
  fileCache: Map<string, string>
): boolean {
  const originExt = path.extname(originFile).toLowerCase();
  const targetExt = path.extname(targetFile).toLowerCase();
  const originLayer = LAYER_BY_EXT[originExt];
  const targetLayer = LAYER_BY_EXT[targetExt];

  if (!originLayer || !targetLayer || originLayer === targetLayer) return true;

  try {
    if (!fileCache.has(originFile)) {
      fileCache.set(originFile, fs.readFileSync(originFile, "utf-8"));
    }
    const originCode = fileCache.get(originFile)!;
    return CROSS_LAYER_PATTERNS.some((pattern) => pattern.test(originCode));
  } catch {
    return false;
  }
}

function extractReferences(code: string, filePath: string, fileCache?: Map<string, string>): string[] {
  let fileHeader = code;
  try {
    if (!fileCache?.has(filePath)) {
      const full = fs.readFileSync(filePath, "utf-8");
      fileCache?.set(filePath, full);
      fileHeader = full.split("\n").slice(0, 20).join("\n");
    } else {
      fileHeader = (fileCache.get(filePath) as string).split("\n").slice(0, 20).join("\n");
    }
  } catch { /* use code as fallback */ }

  const { genericKeywords } = detectContext(filePath, fileHeader);
  const refs = new Set<string>();

  const add = (name: string | undefined) => {
    if (name && name.length > 3 && !genericKeywords.has(name)) refs.add(name);
  };

  // ES6/TS: import { X, Y } from 'z'
  for (const m of code.matchAll(/import\s+\{([^}]+)\}/g)) {
    (m[1] ?? "").split(",")
      .map(s => s.trim().split(/\s+as\s+/)[0]?.trim())
      .forEach(add);
  }

  // ES6/TS: import X from 'z'  or  import * as X from 'z'
  for (const m of code.matchAll(/import\s+(?:\*\s+as\s+)?(\w+)\s+from/g)) add(m[1]);

  // Python: from module import X, Y  or  import X as Y
  for (const m of code.matchAll(/from\s+[\w.]+\s+import\s+([^\n\\]+)/g)) {
    (m[1] ?? "").split(",")
      .map(s => s.trim().split(/\s+as\s+/)[0]?.trim())
      .forEach(add);
  }
  for (const m of code.matchAll(/^import\s+([\w.]+)/gm)) {
    const last = (m[1] ?? "").split(".").pop();
    add(last);
  }

  // Go: import "pkg/subpkg" — use last segment as reference
  for (const m of code.matchAll(/import\s+["']([^"']+)["']/g)) {
    add((m[1] ?? "").split("/").pop());
  }

  // Ruby: require 'some_module'  or  require_relative '../some_file'
  for (const m of code.matchAll(/require(?:_relative)?\s+['"]([^'"]+)['"]/g)) {
    const base = (m[1] ?? "").split("/").pop()?.replace(/\.\w+$/, "") ?? "";
    // convert snake_case to PascalCase for class-style lookup
    const pascal = base.replace(/(^|_)(\w)/g, (_, _sep, c: string) => c.toUpperCase());
    add(base);
    add(pascal);
  }

  // PHP: use Namespace\ClassName  or  use Namespace\ClassName as Alias
  for (const m of code.matchAll(/use\s+[\w\\]+\\(\w+)(?:\s+as\s+(\w+))?/g)) {
    add(m[2] ?? m[1]);
  }

  // Java/Kotlin: import com.example.ClassName
  for (const m of code.matchAll(/^import\s+[\w.]+\.(\w+);?$/gm)) add(m[1]);

  // Rust: use crate::module::Name  or  use std::collections::HashMap
  for (const m of code.matchAll(/use\s+[\w:]+::(\w+)/g)) add(m[1]);

  // Elixir: alias Module.SubModule  or  import Module
  for (const m of code.matchAll(/(?:alias|import)\s+[\w.]+\.(\w+)/g)) add(m[1]);

  // C#: using Namespace.ClassName
  for (const m of code.matchAll(/^using\s+[\w.]+\.(\w+);$/gm)) add(m[1]);

  // camelCase function calls: functionName(
  for (const m of code.matchAll(/\b([a-zA-Z][a-zA-Z0-9]{3,})\s*\(/g)) add(m[1]);

  // snake_case function calls: function_name(  — Python, Ruby, Go, Rust, Elixir
  for (const m of code.matchAll(/\b([a-z][a-z0-9]{2,}(?:_[a-z0-9]+)+)\s*\(/g)) add(m[1]);

  // camelCase identifiers not followed by (
  for (const m of code.matchAll(/\b([a-z][a-zA-Z0-9]{3,}[A-Z][a-zA-Z0-9]+)\b/g)) add(m[1]);

  // PascalCase types/classes used in code
  for (const m of code.matchAll(/\b([A-Z][a-zA-Z]{3,})\b/g)) add(m[1]);

  return [...refs].slice(0, 12);
}


export function searchByRipgrep(query: string, projectPath: string, preExtractedTerms?: string[]): SearchResult[] {
  const terms = preExtractedTerms ?? extractTechnicalTerms(query);
  const rgPath = findRipgrep();

  if (rgPath) {
    return searchWithRipgrep(terms, projectPath, rgPath);
  }

  return searchWithNode(terms, projectPath);
}

let cachedRgPath: string | null | undefined;

function findRipgrep(): string | null {
  if (cachedRgPath !== undefined) return cachedRgPath;

  // 1. bundled binary via @vscode/ripgrep — the canonical path for any platform
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { rgPath } = require("@vscode/ripgrep") as { rgPath: string };
    if (rgPath && fs.existsSync(rgPath)) {
      const verify = spawnSync(rgPath, ["--version"], { stdio: "ignore" });
      if (verify.status === 0) {
        cachedRgPath = rgPath;
        return rgPath;
      }
    }
  } catch {
    // package not available — fall through to system lookup
  }

  // 2. system lookup via `which rg`
  const whichResult = spawnSync("which", ["rg"], { encoding: "utf-8" });
  if (whichResult.status === 0) {
    const found = (whichResult.stdout ?? "").trim().split("\n").find((p) => p && !p.includes(" "));
    if (found) {
      const verify = spawnSync(found, ["--version"], { stdio: "ignore" });
      if (verify.status === 0) {
        cachedRgPath = found;
        return found;
      }
    }
  }

  // 3. fallback to common install paths
  const candidates = [
    "/opt/homebrew/bin/rg",
    "/usr/local/bin/rg",
    "/usr/bin/rg",
    `${process.env["HOME"]}/.cargo/bin/rg`,
    `${process.env["HOME"]}/.local/bin/rg`,
  ];

  for (const rg of candidates) {
    const result = spawnSync(rg, ["--version"], { stdio: "ignore" });
    if (result.status === 0) {
      cachedRgPath = rg;
      return rg;
    }
  }

  if (process.env["LEXIS_DEBUG"] === "true") {
    console.warn("  [warn] ripgrep not found — falling back to slower Node-based search");
  }
  cachedRgPath = null;
  return null;
}

function buildRgPattern(terms: string[]): string {
  // terms come pre-prioritized from extractTechnicalTerms; cap to 12 for regex sanity
  return terms.slice(0, 12)
    .map((t) => {
      const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // snake_case components may appear inside longer identifiers — use lookaround instead of \b
      if (escaped.includes("_")) return escaped;
      return `\\b${escaped}\\b`;
    })
    .join("|");
}

const RIPGREP_IGNORE_GLOBS = [
  "!node_modules/**", "!dist/**", "!build/**", "!.git/**",
  "!.next/**", "!.nuxt/**", "!.svelte-kit/**", "!target/**",
  "!vendor/**", "!__pycache__/**", "!venv/**", "!.venv/**",
  "!coverage/**", "!out/**", "!.turbo/**",
  "!**/*.d.ts", "!**/*.min.js", "!**/*.min.ts",
  "!**/*.map", "!**/*.lock", "!**/*.snap",
  "!**/package-lock.json",
  "!**/*_pb.go", "!**/*.pb.py", "!**/*.generated.*",
  // generated / cache directories (Symfony, Laravel, generic)
  "!**/var/cache/**", "!**/var/log/**", "!**/var/sessions/**",
  "!**/storage/framework/**", "!**/storage/logs/**", "!**/storage/debugbar/**",
  "!**/__CG__*",
  "!**/*.cache.php",
];

function searchWithRipgrep(terms: string[], projectPath: string, rgPath: string): SearchResult[] {
  const pattern = buildRgPattern(terms);
  const globArgs = RIPGREP_IGNORE_GLOBS.flatMap((g) => ["--glob", g]);

  // -U enables multiline mode so patterns can match across line boundaries.
  // --multiline-dotall lets `.` match newlines, useful for capturing multi-line signatures.
  // These flags are safe with our line-oriented patterns and unlock future multi-line patterns.
  const result = spawnSync(
    rgPath,
    [
      "--line-number", "--no-heading", "--max-filesize", "200K",
      "-U", "--multiline-dotall",
      "-e", pattern, ...globArgs, projectPath,
    ],
    { encoding: "utf-8" }
  );

  if (result.status !== 0 && !result.stdout) return [];
  return parseRipgrepOutput(result.stdout ?? "", terms);
}

const SEARCHABLE_EXTS = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|kt|kts|cs|cpp|cc|cxx|c|h|hpp|php|swift|dart|vue|svelte|scala|ex|exs)$/i;
const SKIP_FILE_PATTERNS = [
  /\.min\.[jt]s$/, /\.min\.css$/, /\.map$/, /\.d\.ts$/,
  /\.lock$/, /package-lock\.json$/,
  /[-_](pb|generated)\./, /\.pb\.go$/, /\.pb\.py$/,
  /\.snap$/,
];

function isSearchableFile(name: string): boolean {
  return SEARCHABLE_EXTS.test(name) && !SKIP_FILE_PATTERNS.some((p) => p.test(name));
}

const IGNORE_DIRS_NODE = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "coverage", ".cache", "tmp", "vendor", "target",
  "__pycache__", ".tox", "venv", ".venv", ".bundle",
  ".svelte-kit", ".parcel-cache", "out", ".turbo",
  "migrations", "seeds", "fixtures",
  "generated", "gen", "proto",
  "storybook-static", ".storybook",
  "cache", "logs",
]);

const IGNORE_PATH_PATTERNS_NODE = [
  /\/var\/cache\//,
  /\/var\/log\//,
  /\/var\/sessions\//,
  /\/storage\/(framework|logs|debugbar)\//,
];

function searchWithNode(terms: string[], projectPath: string): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const regexes = terms.map((t) => {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return t.includes("_") ? new RegExp(escaped) : new RegExp(`\\b${escaped}\\b`);
  });

  function walkDir(dir: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS_NODE.has(entry.name)) continue;
        if (IGNORE_PATH_PATTERNS_NODE.some((p) => p.test(full))) continue;
        walkDir(full);
      } else if (entry.isFile() && isSearchableFile(entry.name)) {
        if (IGNORE_PATH_PATTERNS_NODE.some((p) => p.test(full))) continue;
        searchFile(full, regexes, terms, seen, results);
      }
    }
  }

  walkDir(projectPath);
  return sortByRelevanceAndRecency(results);
}

function searchFile(
  file: string,
  regexes: RegExp[],
  terms: string[],
  seen: Set<string>,
  results: SearchResult[]
): void {
  let content: string;
  try { content = fs.readFileSync(file, "utf-8"); } catch { return; }

  const lines = content.split("\n");

  lines.forEach((line, i) => {
    if (!regexes.some((r) => r.test(line))) return;

    const lineNumber = i + 1;
    const { code, lineStart, lineEnd } = extractFunction(file, lineNumber);

    const key = `${file}:${lineStart}`;
    if (seen.has(key)) return;
    seen.add(key);

    const truncated = truncateLongLines(code);
    const matchCount = terms.filter((t) => truncated.includes(t)).length;
    results.push({
      symbol: {
        name: extractFunctionName(truncated) ?? terms[0] ?? "unknown",
        file,
        lineStart,
        lineEnd,
        type: "function",
      },
      code: truncated,
      score: matchCount,
    });
  });
}

const ENTRY_POINT_FILES = new Set([
  "main.ts", "main.js", "index.ts", "index.js", "app.ts", "app.js", "server.ts", "server.js",
  "main.py", "app.py", "wsgi.py", "asgi.py", "manage.py", "run.py",
  "main.go", "main.rs", "lib.rs",
  "app.rb", "config.ru", "application.rb",
  "index.php", "artisan",
  "Application.java", "Application.kt", "Main.java", "Main.kt",
]);

function fileImportanceBonus(filePath: string): number {
  const normalized = filePath.replace(/\\/g, "/");
  const base = path.basename(normalized);

  if (isTestFile(normalized)) return -0.5;

  // core business logic / domain
  if (/[/](core|domain|service|services|business|lib|internal|use.?cases?|pkg)[/]/i.test(normalized)) return 2;
  if (/[/](repositor|entities|models?|app\/Http|app\/Models)[/]/i.test(normalized)) return 2;
  if (/[/](app\/(models?|services?|jobs?|mailers?))[/]/i.test(normalized)) return 2;

  // DDD / hexagonal architecture
  if (/[/](dto|dtos|entities|value.?objects?|aggregates?|specifications?)[/]/i.test(normalized)) return 1.8;

  // CQRS / event-driven
  if (/[/](commands?|queries|events?|handlers?|listeners?|subscribers?|sagas?)[/]/i.test(normalized)) return 1.5;

  // state management (Redux / Pinia / Zustand / NgRx / Vuex / Recoil)
  if (/[/](slices?|stores?|actions|reducers?|mutations?|getters?|selectors?|effects?|atoms?)[/]/i.test(normalized)) return 1.5;

  // React / Vue / Solid patterns
  if (/[/](hooks?|composables?|contexts?|providers?|signals?)[/]/i.test(normalized)) return 1.3;

  // NestJS / Spring / framework infra
  if (/[/](guards?|interceptors?|pipes?|decorators?|middleware|middlewares|filters)[/]/i.test(normalized)) return 1.3;

  // GraphQL
  if (/[/](resolvers?|typedefs?|directives?)[/]/i.test(normalized)) return 1.3;

  // entry points
  if (ENTRY_POINT_FILES.has(base)) return 1.5;

  // routes / controllers / endpoints
  if (/[/](routes?|router|routing|controllers?|handlers?|endpoints?|urls?|views?)[/]/i.test(normalized)) return 1;
  if (/[/](routes?|router|controllers?|urls?)\.[a-z]+$/.test(normalized)) return 1;
  if (/config\/routes/.test(normalized) || /urls\.py$/.test(normalized)) return 1;

  // shared / utils / helpers — useful but not central
  if (/[/](utils?|helpers?|common|shared|constants?|config)[/]/i.test(normalized)) return 0.3;

  return 0;
}

function sortByRelevanceAndRecency(results: SearchResult[]): SearchResult[] {
  return results.sort((a, b) => {
    const scoreA = a.score + fileImportanceBonus(a.symbol.file);
    const scoreB = b.score + fileImportanceBonus(b.symbol.file);
    if (scoreB !== scoreA) return scoreB - scoreA;
    try {
      const mtimeA = fs.statSync(a.symbol.file).mtimeMs;
      const mtimeB = fs.statSync(b.symbol.file).mtimeMs;
      return mtimeB - mtimeA;
    } catch {
      return 0;
    }
  });
}

function truncateLongLines(code: string, maxChars: number = 500): string {
  return code
    .split("\n")
    .map((line) => line.length > maxChars ? line.slice(0, maxChars) + " …" : line)
    .join("\n");
}

function parseRipgrepOutput(output: string, terms: string[]): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const line of output.trim().split("\n").slice(0, 1000)) {
    const match = line.match(/^(.+):(\d+):(.+)$/);
    if (!match) continue;

    const [, file, lineNum] = match;
    if (!file || !isSearchableFile(path.basename(file))) continue;
    if (file.includes("node_modules") || file.includes("/.git/")) continue;

    const lineNumber = parseInt(lineNum);
    const { code, lineStart, lineEnd } = extractFunction(file, lineNumber);

    const key = `${file}:${lineStart}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const truncated = truncateLongLines(code);
    const matchCount = terms.filter((t) => truncated.includes(t)).length;
    results.push({
      symbol: {
        name: extractFunctionName(truncated) ?? terms[0] ?? "unknown",
        file,
        lineStart,
        lineEnd,
        type: "function",
      },
      code: truncated,
      score: matchCount,
    });
  }

  return sortByRelevanceAndRecency(results);
}

function fallbackSymbolSearch(query: string, index: Index, topK: number): SearchResult[] {
  const queryTerms = tokenize(query);
  const scored: SearchResult[] = [];

  for (const symbol of index.symbols) {
    const score = scoreSymbol(symbol, queryTerms);
    if (score > 0) {
      const { code, lineStart, lineEnd } = extractFunction(symbol.file, symbol.lineStart);
      scored.push({ symbol: { ...symbol, lineStart, lineEnd }, code, score });
    }
  }

  return dedup(scored.sort((a, b) => b.score - a.score)).slice(0, topK);
}

// extractTechnicalTerms is now provided by query-analyzer
// (it includes synonym expansion + compound permutations)

// Matches the start of a top-level function/method in any supported language.
// Requires no leading whitespace so we don't match nested functions.
const TOP_LEVEL_FN = new RegExp([
  // JS / TS
  /^(export\s+)?(default\s+)?(async\s+)?function[\s*]+\w+/.source,
  /^(export\s+)?(const|let)\s+\w+\s*=\s*(async\s+)?(\(|function)/.source,
  // Rust
  /^(pub(\([^)]*\))?\s+)?(async\s+)?fn\s+\w+/.source,
  // Go: func name( or func (recv) name(
  /^func(\s+\([^)]+\))?\s+\w+\s*\(/.source,
  // Python / Elixir / Scala / Ruby
  /^(async\s+)?def\s+\w+/.source,
  /^(defp?|defmacro)\s+\w+/.source,   // Elixir
  // Kotlin
  /^(suspend\s+)?fun\s+\w+/.source,
  // Swift
  /^(public|private|internal|open|fileprivate|\s)*(mutating\s+)?func\s+\w+/.source,
  // PHP
  /^(public|private|protected|static|\s)*(function)\s+\w+/.source,
  // Java / C# — public/private Type methodName(
  /^(public|private|protected|internal|static|override|abstract|final|async|virtual|sealed)[\s\w<>\[\]]+\s+\w+\s*\(/.source,
  // Ruby top-level def
  /^def\s+(self\.)?\w+/.source,
  // C / C++ — returnType functionName(
  /^\w[\w\s*<>:]+\s+\w+\s*\([^)]*\)\s*(const\s*)?\{?\s*$/.source,
].join("|"));

function detectEndStrategy(ext: string): "braces" | "indent" | "end_keyword" {
  if ([".py"].includes(ext)) return "indent";
  if ([".rb", ".ex", ".exs"].includes(ext)) return "end_keyword";
  return "braces";
}

function extractFunction(file: string, lineNumber: number): { code: string; lineStart: number; lineEnd: number } {
  try {
    const content = fs.readFileSync(file, "utf-8");
    const lines = content.split("\n");
    const ext = path.extname(file).toLowerCase();
    const strategy = detectEndStrategy(ext);

    let start = lineNumber - 1;
    let functionFound = false;
    // search up to 50 lines back for an enclosing function
    for (let i = lineNumber - 1; i >= Math.max(0, lineNumber - 50); i--) {
      const line = lines[i] ?? "";
      if (TOP_LEVEL_FN.test(line)) {
        start = i;
        functionFound = true;
        break;
      }
    }

    // not inside a function (top-level usage, import, type alias, etc.)
    // return a window of surrounding context instead of trying to delimit a body.
    // tunable via LEXIS_CONTEXT_BEFORE / LEXIS_CONTEXT_AFTER (default: 8 + 12 = 20 lines)
    if (!functionFound) {
      const before = parseInt(process.env["LEXIS_CONTEXT_BEFORE"] ?? "8");
      const after = parseInt(process.env["LEXIS_CONTEXT_AFTER"] ?? "12");
      const ctxStart = Math.max(0, lineNumber - 1 - before);
      const ctxEnd = Math.min(lines.length - 1, lineNumber - 1 + after);
      return {
        code: lines.slice(ctxStart, ctxEnd + 1).join("\n"),
        lineStart: ctxStart + 1,
        lineEnd: ctxEnd + 1,
      };
    }

    // capture leading decorators: @decorator (Python, Java, Kotlin, Swift, PHP, C#)
    while (start > 0 && (lines[start - 1] ?? "").trim().startsWith("@")) {
      start--;
    }

    const maxLines = 60;
    let end = Math.min(start + maxLines, lines.length - 1);

    if (strategy === "braces") {
      let depth = 0;
      for (let i = start; i < lines.length; i++) {
        const line = lines[i] ?? "";
        depth += (line.match(/\{/g) ?? []).length;
        depth -= (line.match(/\}/g) ?? []).length;
        if (i > start && depth <= 0) { end = i; break; }
      }

    } else if (strategy === "indent") {
      // Python: end when we find a non-empty line at same or lower indent as start
      const startIndent = (lines[start] ?? "").match(/^(\s*)/)?.[1]?.length ?? 0;
      for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (line.trim() === "") continue;
        const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
        if (indent <= startIndent) { end = i - 1; break; }
      }

    } else {
      // Ruby / Elixir: count def/do..end pairs
      let depth = 0;
      for (let i = start; i < lines.length; i++) {
        const line = (lines[i] ?? "").trim();
        if (/^(def|do|if|unless|case|while|until|for|begin|module|class)\b/.test(line)) depth++;
        if (/^end\b/.test(line)) {
          depth--;
          if (depth <= 0) { end = i; break; }
        }
      }
    }

    if (end - start > maxLines) end = start + maxLines;

    return {
      code: lines.slice(start, end + 1).join("\n"),
      lineStart: start + 1,
      lineEnd: end + 1,
    };
  } catch {
    const fallback = extractCode(file, Math.max(1, lineNumber - 5), lineNumber + 20);
    return { code: fallback, lineStart: Math.max(1, lineNumber - 5), lineEnd: lineNumber + 20 };
  }
}

function extractFunctionName(code: string): string | null {
  const match = code.match(
    /(?:function\s+(\w+)|const\s+(\w+)\s*=|fn\s+(\w+)|def\s+(\w+)|func(?:\s+\([^)]+\))?\s+(\w+)|fun\s+(\w+)|defp?\s+(\w+))/
  );
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7] ?? null;
}

function dedup(results: SearchResult[]): SearchResult[] {
  const kept: SearchResult[] = [];

  for (const r of results) {
    const overlaps = kept.some(
      (k) =>
        k.symbol.file === r.symbol.file &&
        r.symbol.lineStart <= k.symbol.lineEnd &&
        r.symbol.lineEnd >= k.symbol.lineStart
    );
    if (!overlaps) kept.push(r);
  }

  return kept;
}

// Adds class header + imports to chunks that are methods inside a class.
// This gives the LLM full OOP context (extends/implements, dependencies) without
// requiring a separate read_file call.
function enrichWithClassContext(results: SearchResult[]): SearchResult[] {
  const fileCache = new Map<string, string[]>();
  const enabled = process.env["LEXIS_ENRICH_CONTEXT"] !== "false";
  if (!enabled) return results;

  return results.map((r) => {
    try {
      let lines = fileCache.get(r.symbol.file);
      if (!lines) {
        lines = fs.readFileSync(r.symbol.file, "utf-8").split("\n");
        fileCache.set(r.symbol.file, lines);
      }

      // skip if chunk already starts at line 1 (it includes file header)
      if (r.symbol.lineStart <= 5) return r;

      const classHeader = findEnclosingClass(lines, r.symbol.lineStart);
      if (!classHeader) return r;

      const imports = extractImports(lines);

      const headerParts: string[] = [];
      if (imports.length > 0) headerParts.push(imports.join("\n"));
      headerParts.push(`${classHeader.line}  // ← class header from line ${classHeader.lineNumber}`);
      headerParts.push(`  // ... (other members omitted)`);
      headerParts.push("");
      headerParts.push(r.code);

      return { ...r, code: headerParts.join("\n") };
    } catch {
      return r;
    }
  });
}

const IMPORT_LINE_REGEX = /^(import|use|from|namespace|package|using|require|alias)\s|^#include\s/;

function extractImports(lines: string[]): string[] {
  const imports: string[] = [];
  // scan up to first 60 lines or until we find substantial code
  const limit = Math.min(60, lines.length);
  for (let i = 0; i < limit; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed === "") {
      if (imports.length > 0) imports.push(line);
      continue;
    }
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("#") ||
      IMPORT_LINE_REGEX.test(trimmed) ||
      trimmed.startsWith("declare ")
    ) {
      imports.push(line);
    } else {
      // hit a class/function definition — stop
      break;
    }
  }
  // trim trailing blank lines
  while (imports.length > 0 && imports[imports.length - 1]!.trim() === "") {
    imports.pop();
  }
  return imports;
}

const CLASS_HEADER_REGEX = /^(export\s+)?(default\s+)?(abstract\s+|final\s+|sealed\s+|public\s+|private\s+|protected\s+|static\s+)*(class|interface|trait|struct|enum|protocol|object|record|module)\s+\w+/;

function findEnclosingClass(lines: string[], chunkStartLine: number): { line: string; lineNumber: number } | null {
  // search backwards from chunk start to find the enclosing class declaration
  for (let i = chunkStartLine - 2; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (CLASS_HEADER_REGEX.test(line)) {
      return { line, lineNumber: i + 1 };
    }
  }
  return null;
}

// Fuses chunks from the same file that are within `gap` lines of each other.
// E.g. chunks (18-38) and (52-72) → single chunk (18-72).
// Caps merged chunks at `maxLines` to avoid swallowing the whole file.
function mergeAdjacent(
  results: SearchResult[],
  gap: number = parseInt(process.env["LEXIS_MERGE_GAP"] ?? "10"),
  maxLines: number = 200
): SearchResult[] {
  const byFile = new Map<string, SearchResult[]>();
  for (const r of results) {
    if (!byFile.has(r.symbol.file)) byFile.set(r.symbol.file, []);
    byFile.get(r.symbol.file)!.push(r);
  }

  const merged: SearchResult[] = [];
  for (const [file, fileChunks] of byFile) {
    const sorted = [...fileChunks].sort((a, b) => a.symbol.lineStart - b.symbol.lineStart);
    let current = sorted[0];
    if (!current) continue;

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i]!;
      const distance = next.symbol.lineStart - current.symbol.lineEnd;
      const fusedSize = next.symbol.lineEnd - current.symbol.lineStart + 1;

      if (distance <= gap && fusedSize <= maxLines) {
        // fuse: extend the range, keep the higher score, re-extract code
        const newEnd = Math.max(current.symbol.lineEnd, next.symbol.lineEnd);
        const fusedCode = extractCode(file, current.symbol.lineStart, newEnd);
        current = {
          symbol: {
            ...current.symbol,
            lineEnd: newEnd,
            // keep the most descriptive name (longest between the two)
            name: current.symbol.name.length >= next.symbol.name.length
              ? current.symbol.name
              : next.symbol.name,
          },
          code: truncateLongLines(fusedCode),
          score: Math.max(current.score, next.score),
        };
      } else {
        merged.push(current);
        current = next;
      }
    }
    merged.push(current);
  }

  return merged;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s_\-./\\]+/)
    .filter((t) => t.length > 2);
}

function scoreSymbol(symbol: Symbol, queryTerms: string[]): number {
  const nameTokens = tokenize(symbol.name);
  const filePath = symbol.file.toLowerCase();
  let score = 0;

  for (const term of queryTerms) {
    if (nameTokens.some((t) => t.includes(term) || term.includes(t))) score += 3;
    if (filePath.includes(term)) score += 1;
  }

  return score;
}

function extractCode(file: string, lineStart: number, lineEnd: number): string {
  try {
    const content = fs.readFileSync(file, "utf-8");
    const lines = content.split("\n");
    return lines.slice(lineStart - 1, lineEnd).join("\n");
  } catch {
    return "";
  }
}

// ── get_symbol ──────────────────────────────────────────────────────────────

// File path / content heuristics to rank candidates when multiple symbols share a name.
// Concrete implementations beat interfaces, abstract declarations, and stubs.
function scoreCandidateForGetSymbol(s: Symbol): number {
  let score = 0;
  const f = s.file.toLowerCase();

  // Path penalties — interfaces and abstracts usually live in dedicated paths
  if (/interface\.[a-z]+$/.test(f)) score -= 10;
  if (/abstract\.[a-z]+$/.test(f)) score -= 5;
  if (/\/(domain|interfaces?)\//.test(f) && /interface/i.test(path.basename(s.file))) score -= 8;

  // Read the declaration line to detect interface vs class
  try {
    const content = fs.readFileSync(s.file, "utf-8");
    const lines = content.split("\n");
    const decl = lines[s.lineStart - 1] ?? "";

    // interface / abstract declarations
    if (/\binterface\s+\w/.test(decl)) score -= 10;
    if (/\babstract\s+(class|function)\b/.test(decl)) score -= 5;

    // signature-only methods (interface or abstract): line ends with `;` and no `{`
    if (!decl.includes("{") && decl.trim().endsWith(";")) score -= 8;

    // concrete class / function with body
    if (/\bclass\s+\w/.test(decl) && !/\babstract\b/.test(decl)) score += 5;
    if (decl.includes("{")) score += 2;
  } catch {
    // unreadable file — keep neutral score
  }

  // Type bonuses
  if (s.type === "class") score += 1;
  if (s.type === "method" || s.type === "function") score += 1;

  return score;
}

export function getSymbol(
  symbolName: string,
  fileFilter: string | undefined,
  index: Index
): { symbol: Symbol; body: string } | null {
  let candidates = index.symbols.filter(
    (s) =>
      s.name.toLowerCase() === symbolName.toLowerCase() &&
      (!fileFilter || s.file.toLowerCase().includes(fileFilter.toLowerCase()))
  );

  if (candidates.length === 0) {
    candidates = index.symbols.filter(
      (s) =>
        s.name.toLowerCase().includes(symbolName.toLowerCase()) &&
        (!fileFilter || s.file.toLowerCase().includes(fileFilter.toLowerCase()))
    );
  }

  if (candidates.length === 0) return null;

  // Fix: prefer concrete implementation over interface/abstract declaration.
  // Interfaces and abstract methods have signature-only bodies; concrete impls have real code.
  const ranked = candidates
    .map((s) => ({ s, score: scoreCandidateForGetSymbol(s) }))
    .sort((a, b) => b.score - a.score);
  const sym = ranked[0]!.s;

  let content: string;
  try {
    content = fs.readFileSync(sym.file, "utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n");
  const start = sym.lineStart - 1;
  const maxLines = 150;
  let depth = 0;
  let foundOpen = false;
  let end = Math.min(start + maxLines, lines.length);

  // single-line const/variable with no body braces: const x = expr;
  const firstLine = lines[start]?.trim() ?? "";
  if (!firstLine.includes("{") && firstLine.endsWith(";")) {
    return { symbol: sym, body: lines[start].toString() };
  }

  for (let i = start; i < lines.length && i < start + maxLines; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") { depth++; foundOpen = true; }
      if (ch === "}") depth--;
    }
    if (foundOpen && depth <= 0) { end = i + 1; break; }
  }

  return { symbol: sym, body: lines.slice(start, end).join("\n") };
}

// ── find_references ─────────────────────────────────────────────────────────

export interface Reference {
  file: string;
  line: number;
  kind: "definition" | "call" | "import" | "type" | "other";
  content: string;
}

export function findReferences(symbolName: string, projectPath: string, index: Index): Reference[] {
  const rgPath = findRipgrep();
  const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  let stdout = "";
  if (rgPath) {
    const result = spawnSync(
      rgPath,
      [
        "--line-number", "--no-heading", "--max-filesize", "200K",
        "-e", `\\b${escaped}\\b`,
        "--glob", "!*.d.ts",
        "--glob", "!dist/**",
        "--glob", "!node_modules/**",
        projectPath,
      ],
      { encoding: "utf-8" }
    );
    stdout = result.stdout ?? "";
  }

  const defSet = new Set(
    index.symbols
      .filter((s) => s.name === symbolName)
      .map((s) => `${s.file}:${s.lineStart}`)
  );

  const refs: Reference[] = [];

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineStr, content] = m;
    const lineNum = parseInt(lineStr, 10);
    if (isNaN(lineNum)) continue;

    const trimmed = content.trim();
    let kind: Reference["kind"];

    if (defSet.has(`${file}:${lineNum}`)) {
      kind = "definition";
    } else if (/\bimport\b/.test(trimmed)) {
      kind = "import";
    } else if (new RegExp(`\\b${escaped}\\s*\\(`).test(trimmed)) {
      kind = "call";
    } else if (new RegExp(`[:><]\\s*${escaped}\\b|\\b${escaped}\\[\\]|\\b${escaped}\\s*[|&]`).test(trimmed)) {
      kind = "type";
    } else {
      kind = "other";
    }

    refs.push({ file, line: lineNum, kind, content: trimmed });
  }

  const order: Record<Reference["kind"], number> = { definition: 0, call: 1, import: 2, type: 3, other: 4 };
  refs.sort((a, b) => {
    const kd = order[a.kind] - order[b.kind];
    if (kd !== 0) return kd;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });

  return refs;
}

// ── get_context ──────────────────────────────────────────────────────────────

export interface ContextResult {
  fnCode: string;
  fnName: string | null;
  fnLineStart: number;
  fnLineEnd: number;
  callers: SearchResult[];
  types: SearchResult[];
  tests: SearchResult[];
}

export function getContext(
  file: string,
  line: number,
  projectPath: string,
  index: Index
): ContextResult {
  const absFile = path.isAbsolute(file) ? file : path.resolve(projectPath, file);
  const extracted = extractFunction(absFile, line);
  const fnName = extractFunctionName(extracted.code);

  const syntheticResult: SearchResult = {
    symbol: {
      name: fnName ?? path.basename(absFile, path.extname(absFile)),
      file: absFile,
      lineStart: extracted.lineStart,
      lineEnd: extracted.lineEnd,
      type: "function",
    },
    code: extracted.code,
    score: 1,
  };

  const callers = fnName && !GENERIC_NAMES.has(fnName.toLowerCase())
    ? searchCallers([syntheticResult], projectPath, [], false)
    : [];
  const types  = searchTypeDefinitions([syntheticResult], projectPath, false);
  const tests  = searchRelatedTests([syntheticResult], projectPath, false);

  return {
    fnCode: extracted.code,
    fnName,
    fnLineStart: extracted.lineStart,
    fnLineEnd:   extracted.lineEnd,
    callers,
    types,
    tests,
  };
}

// ── Suggestions ─────────────────────────────────────────────────────────────
// When a query yields no results, propose the closest indexed symbol names so
// Claude can retry without burning a second exploratory query.

export interface Suggestion {
  name: string;
  file: string;
  lineStart: number;
  type: Symbol["type"];
  reason: "exact-substring" | "case-variant" | "edit-distance" | "token-overlap";
}

// Two-row Levenshtein, lowercased, early-exit when distance exceeds threshold.
function editDistance(a: string, b: string, threshold: number): number {
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > threshold) return threshold + 1;
  if (al === 0) return bl;
  if (bl === 0) return al;

  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > threshold) return threshold + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}

// Identifier-aware tokenizer — handles camelCase, snake_case, kebab-case, dots.
function tokenizeIdent(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")    // camelCase split
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // ABCWord → ABC Word
    .replace(/[_\-.]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

// Two tokens "match" if equal or within edit-distance 1 (handles typos like chnk/chunk).
// Edit-distance 1 only for tokens of length ≥4 to avoid noise (no/on, by/be).
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  return editDistance(a, b, 1) <= 1;
}

// Fuzzy Jaccard: tolerates token-level typos and word reordering.
function tokenSimilarity(a: string, b: string): number {
  const ta = tokenizeIdent(a);
  const tb = tokenizeIdent(b);
  if (ta.length === 0 || tb.length === 0) return 0;

  // Count tokens of `a` with at least one fuzzy match in `b`
  let aMatched = 0;
  const bUsed = new Array(tb.length).fill(false);
  for (const tokenA of ta) {
    for (let j = 0; j < tb.length; j++) {
      if (bUsed[j]) continue;
      if (tokensMatch(tokenA, tb[j]!)) { bUsed[j] = true; aMatched++; break; }
    }
  }

  const union = ta.length + tb.length - aMatched;
  return union === 0 ? 0 : aMatched / union;
}

export function suggestSimilar(query: string, index: Index, limit: number = 5): Suggestion[] {
  if (!query || query.length < 2) return [];

  const queryLower = query.toLowerCase();
  const seen = new Set<string>();
  const out: Suggestion[] = [];

  const push = (s: Symbol, reason: Suggestion["reason"]): boolean => {
    const key = `${s.name}|${s.file}`;
    if (seen.has(key)) return false;
    seen.add(key);
    out.push({ name: s.name, file: s.file, lineStart: s.lineStart, type: s.type, reason });
    return out.length >= limit;
  };

  // 1. Case variants — same letters, different case
  for (const s of index.symbols) {
    if (s.name.toLowerCase() === queryLower && s.name !== query) {
      if (push(s, "case-variant")) return out;
    }
  }

  // 2. Edit distance — typos and missing/extra characters. Run BEFORE substring
  //    so a near-perfect match isn't drowned out by short substrings.
  const threshold = queryLower.length <= 5 ? 1 : queryLower.length <= 10 ? 2 : 3;
  const editCandidates: Array<{ s: Symbol; d: number }> = [];
  for (const s of index.symbols) {
    const lower = s.name.toLowerCase();
    if (lower === queryLower) continue;
    if (Math.abs(lower.length - queryLower.length) > threshold) continue;
    const d = editDistance(queryLower, lower, threshold);
    if (d <= threshold) editCandidates.push({ s, d });
  }
  editCandidates.sort((a, b) => a.d - b.d || a.s.name.length - b.s.name.length);
  for (const { s } of editCandidates) {
    if (push(s, "edit-distance")) return out;
  }

  // 3. Token overlap — handles reordered words (chnk_documents → DocumentChunk)
  //    Requires the query to have at least 2 meaningful tokens (otherwise edit-distance covers it).
  const queryTokens = tokenizeIdent(query);
  if (queryTokens.length >= 2) {
    const tokenCandidates: Array<{ s: Symbol; sim: number }> = [];
    for (const s of index.symbols) {
      if (seen.has(`${s.name}|${s.file}`)) continue;
      const sim = tokenSimilarity(query, s.name);
      if (sim >= 0.5) tokenCandidates.push({ s, sim });
    }
    tokenCandidates.sort((a, b) => b.sim - a.sim || a.s.name.length - b.s.name.length);
    for (const { s } of tokenCandidates) {
      if (push(s, "token-overlap")) return out;
    }
  }

  // 4. Substring — only "indexed name contains query" (not the reverse), and the
  //    query must be ≥4 chars so it's not a vague fragment like "get" or "do".
  if (queryLower.length >= 4) {
    const subCandidates: Symbol[] = [];
    for (const s of index.symbols) {
      if (seen.has(`${s.name}|${s.file}`)) continue;
      const lower = s.name.toLowerCase();
      if (lower !== queryLower && lower.includes(queryLower)) {
        subCandidates.push(s);
      }
    }
    // Prefer shorter names (closer to the query)
    subCandidates.sort((a, b) => a.name.length - b.name.length);
    for (const s of subCandidates) {
      if (push(s, "exact-substring")) return out;
    }
  }

  return out;
}
