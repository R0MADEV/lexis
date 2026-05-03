import * as fs from "fs";
import * as path from "path";
import { search } from "../../core/searcher";
import {
  buildIterativePrompt,
  parseLLMResponse,
  estimateTokens,
  langInstruction,
  Chunk,
  LexisTool,
} from "../../core/chunker";
import { loadIndex } from "../../adapters/storage/index-file";
import { ask as askClaude, askWithTools as askClaudeWithTools } from "../../adapters/llm/claude";
import { ask as askOpenAI, askWithTools as askOpenAIWithTools } from "../../adapters/llm/openai";
import { Index } from "../../core/indexer";
import { getGitContext, formatGitContext } from "../../core/git-context";
import { scanProjectStructure, formatProjectStructure } from "../../core/project-scanner";

type LLMType = "claude" | "openai";

function resolveLLMType(): LLMType {
  if (process.env["ANTHROPIC_API_KEY"]) return "claude";
  if (process.env["OPENAI_API_KEY"]) return "openai";
  console.error("No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
  process.exit(1);
}

function resolveLLMFn(): (prompt: string) => Promise<string> {
  return resolveLLMType() === "claude" ? askClaude : askOpenAI;
}

export interface AskOptions {
  depth?: number;
  topK?: number;
}

export async function askCommand(question: string, projectPath: string, lang?: string, opts?: AskOptions): Promise<void> {
  const index = loadIndex(projectPath);
  if (!index) {
    console.error("No index found. Run: lexis index <path> first.");
    process.exit(1);
  }

  const ageHours = (Date.now() - new Date(index.createdAt).getTime()) / 3_600_000;
  if (ageHours > 24) {
    console.warn(`[warning] Index is ${Math.floor(ageHours)}h old — run 'lexis index <path>' to refresh.`);
  }

  const maxIterations = parseInt(process.env["LEXIS_MAX_ITERATIONS"] ?? "3");
  const resolvedLang = lang ?? process.env["LEXIS_LANG"] ?? "en";
  const useToolCalling = process.env["LEXIS_TOOL_CALLING"] !== "false";
  const depth = opts?.depth ?? 2;
  const topK = opts?.topK ?? 5;

  if (useToolCalling) {
    await toolCallingMode(question, projectPath, index, resolvedLang, resolveLLMType(), topK, depth);
  } else {
    await reasoningLoop(question, projectPath, index, resolvedLang, maxIterations, resolveLLMFn(), topK, depth);
  }
}

async function toolCallingMode(
  question: string,
  projectPath: string,
  index: Index,
  lang: string,
  llmType: LLMType,
  topK: number = 5,
  depth: number = 2
): Promise<void> {
  const gitCtx = getGitContext(projectPath);
  const gitSection = gitCtx ? `\n\n${formatGitContext(gitCtx, lang)}` : "";

  const projectStructure = scanProjectStructure(projectPath);
  const structureSection = `\n\n${formatProjectStructure(projectStructure, lang)}`;

  const searchedQueries = new Set<string>();

  const tools: LexisTool[] = [
    {
      name: "search_code",
      description: "Search for relevant code. Use output modes to control verbosity:\n- 'content' (default): full code chunks with file paths\n- 'files': just the list of matching file paths (no code)\n- 'count': just the number of matches and files (cheapest, ideal for 'how many X' questions)",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search terms or identifier name" },
          output: {
            type: "string",
            description: "Output mode: 'content' (full code, default), 'files' (paths only), or 'count' (just totals)",
          },
        },
        required: ["query"],
      },
      execute: async (args) => {
        const query = args["query"] as string;
        const output = (args["output"] as string | undefined) ?? "content";

        const cacheKey = `${output}:${query}`;
        if (searchedQueries.has(cacheKey)) {
          console.log(`\n[cache] Already searched: "${query}" (${output})`);
          return "Already searched, no new results.";
        }
        searchedQueries.add(cacheKey);

        console.log(`\n[tool: search_code] "${query}" (output=${output})`);
        const results = search(query, index, projectPath, topK, depth);
        if (results.length === 0) return "No results found.";

        if (output === "count") {
          const uniqueFiles = new Set(results.map((r) => r.symbol.file));
          console.log(`  ${results.length} matches in ${uniqueFiles.size} files`);
          return `${results.length} matches across ${uniqueFiles.size} files.`;
        }

        if (output === "files") {
          const uniqueFiles = [...new Set(results.map((r) => r.symbol.file))];
          console.log(`  ${uniqueFiles.length} files`);
          return uniqueFiles.join("\n");
        }

        // default: 'content'
        const toolLimit = parseInt(process.env["LEXIS_TOOL_RESULT_LIMIT"] ?? "20");
        const limited = results.slice(0, toolLimit);
        const overflow = results.length - limited.length;

        limited.forEach((r) => {
          console.log(`  ${r.symbol.file} (lines ${r.symbol.lineStart}-${r.symbol.lineEnd}) → ${r.symbol.name}`);
        });
        if (overflow > 0) console.log(`  [... ${overflow} more results omitted]`);

        const body = limited
          .map((r) =>
            `FILE: ${r.symbol.file} (lines ${r.symbol.lineStart}-${r.symbol.lineEnd})\nSYMBOL: ${r.symbol.name}\nCODE:\n\`\`\`\n${r.code}\n\`\`\``
          )
          .join("\n\n---\n\n");

        return overflow > 0
          ? `${body}\n\n[${overflow} additional results omitted — refine your query, or use output='files' / output='count' for a cheaper overview.]`
          : body;
      },
    },
    {
      name: "read_file",
      description: "Read a file with optional pagination. Use offset/limit for large files (e.g. offset=300, limit=300 reads lines 301-600). Default reads the first 300 lines.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path" },
          offset: { type: "number", description: "Line number to start reading from (1-indexed). Default: 1" },
          limit: { type: "number", description: "Maximum number of lines to read. Default: 300" },
        },
        required: ["path"],
      },
      execute: async (args) => {
        const filePath = args["path"] as string;
        const offsetRaw = args["offset"];
        const limitRaw = args["limit"];
        const offset = Math.max(1, typeof offsetRaw === "number" ? offsetRaw : 1);
        const limit = Math.max(1, typeof limitRaw === "number" ? limitRaw : 300);

        const resolved = path.resolve(filePath);
        const projectResolved = path.resolve(projectPath);
        if (!resolved.startsWith(projectResolved + path.sep) && resolved !== projectResolved) {
          return "Access denied: path is outside the project directory.";
        }
        console.log(`\n[tool: read_file] "${filePath}" (lines ${offset}-${offset + limit - 1})`);
        try {
          const content = fs.readFileSync(resolved, "utf-8");
          const allLines = content.split("\n");
          const totalLines = allLines.length;
          const startIdx = offset - 1;
          const endIdx = Math.min(startIdx + limit, totalLines);
          const slice = allLines.slice(startIdx, endIdx);

          const numbered = slice
            .map((line, i) => `${(startIdx + i + 1).toString().padStart(6, " ")}\t${line}`)
            .join("\n");

          const header = `FILE: ${resolved} (showing lines ${offset}-${endIdx} of ${totalLines})\n`;
          const footer = endIdx < totalLines
            ? `\n\n[... ${totalLines - endIdx} more lines. Read with offset=${endIdx + 1} to continue.]`
            : "";
          return header + numbered + footer;
        } catch {
          return "Could not read file.";
        }
      },
    },
    {
      name: "list_symbols",
      description: "List functions, classes, and methods in the index. Filter by file path substring or symbol name substring.",
      input_schema: {
        type: "object",
        properties: {
          file_filter: { type: "string", description: "Substring to match against file paths (optional)" },
          name_filter: { type: "string", description: "Substring to match against symbol names (optional)" },
        },
        required: [],
      },
      execute: async (args) => {
        const fileFilter = (args["file_filter"] as string | undefined)?.toLowerCase();
        const nameFilter = (args["name_filter"] as string | undefined)?.toLowerCase();

        let symbols = index.symbols;
        if (fileFilter) symbols = symbols.filter((s) => s.file.toLowerCase().includes(fileFilter));
        if (nameFilter) symbols = symbols.filter((s) => s.name.toLowerCase().includes(nameFilter));

        if (symbols.length === 0) return "No symbols found.";

        const lines = symbols.slice(0, 60).map((s) => `${s.file}:${s.lineStart} [${s.type}] ${s.name}`);
        const suffix = symbols.length > 60 ? `\n... (${symbols.length - 60} more)` : "";
        console.log(`\n[tool: list_symbols] ${symbols.length} result(s)`);
        return lines.join("\n") + suffix;
      },
    },
    {
      name: "find_file",
      description: "Find indexed files in the project matching a name or path pattern",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Substring to match in the file path or name" },
        },
        required: ["pattern"],
      },
      execute: async (args) => {
        const pattern = (args["pattern"] as string).toLowerCase();
        const matched = index.files.filter((f) => f.toLowerCase().includes(pattern));
        console.log(`\n[tool: find_file] "${pattern}" → ${matched.length} result(s)`);
        if (matched.length === 0) return "No files found.";
        const suffix = matched.length > 30 ? `\n... (${matched.length - 30} more)` : "";
        return matched.slice(0, 30).join("\n") + suffix;
      },
    },
  ];

  const langNote = langInstruction(lang);
  const systemPrompt = `You are an expert code analyst. Use the available tools to find relevant code and answer the user's question.

Strategy:
- For "how many X" / "where is X" / "list all X" → use search_code with output='count' or output='files' first (much cheaper).
- For exploration → use find_file or list_symbols to orient yourself.
- For deep dives → use search_code with output='content' (default).
- For complete context → use read_file only when you need to see a full file.

Be efficient: prefer cheaper output modes when possible.${langNote}${structureSection}${gitSection}`;

  const estimatedTokens = estimateTokens(systemPrompt + question);
  console.log(`\n[estimated tokens: ~${estimatedTokens}] mode: tool calling (${llmType})`);

  const answer = llmType === "claude"
    ? await askClaudeWithTools(systemPrompt, question, tools)
    : await askOpenAIWithTools(systemPrompt, question, tools);

  console.log("\nFINAL ANSWER:\n");
  console.log(answer);
}

async function reasoningLoop(
  question: string,
  projectPath: string,
  index: Index,
  lang: string,
  maxIterations: number,
  llm: (prompt: string) => Promise<string>,
  topK: number = 5,
  depth: number = 2
): Promise<void> {
  const MAX_CONTEXT_TOKENS = parseInt(process.env["LEXIS_MAX_TOKENS"] ?? "100000");
  const allChunks: Chunk[] = [];
  const visitedFiles = new Set<string>();
  const searchedQueries = new Set<string>();
  let partialAnalysis: string | null = null;
  let currentQuery = question;

  const gitCtx = getGitContext(projectPath);
  const gitFormatted = gitCtx ? formatGitContext(gitCtx, lang) : undefined;

  const projectStructure = scanProjectStructure(projectPath);
  const structureFormatted = formatProjectStructure(projectStructure, lang);
  const combinedContext = [structureFormatted, gitFormatted].filter(Boolean).join("\n\n");

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const normalizedQuery = currentQuery.trim().toLowerCase();
    if (searchedQueries.has(normalizedQuery)) {
      console.log(`\n[cache] Query already searched: "${currentQuery}"`);
      break;
    }
    searchedQueries.add(normalizedQuery);

    console.log(`\n[Iteration ${iteration}/${maxIterations}] Searching: "${currentQuery}"`);

    const results = search(currentQuery, index, projectPath, topK, depth);

    if (results.length === 0) {
      console.log("No more relevant results found.");
      break;
    }

    const newChunks: Chunk[] = [];
    for (const r of results) {
      if (visitedFiles.has(r.symbol.file)) continue;
      visitedFiles.add(r.symbol.file);
      const chunk: Chunk = {
        file: r.symbol.file,
        lineStart: r.symbol.lineStart,
        lineEnd: r.symbol.lineEnd,
        symbolName: r.symbol.name,
        code: r.code,
      };
      allChunks.push(chunk);
      newChunks.push(chunk);
    }

    console.log("\n--- CHUNKS ---");
    newChunks.forEach((c) => {
      console.log(`  ${c.file} (lines ${c.lineStart}-${c.lineEnd}) → ${c.symbolName}`);
    });
    console.log("--------------");

    const contextTokens = estimateTokens(allChunks.map((c) => c.code).join("\n"));
    if (contextTokens > MAX_CONTEXT_TOKENS) {
      console.log(`\n[token budget] ~${contextTokens} tokens accumulated — generating answer now.`);
      break;
    }

    const prompt = buildIterativePrompt(question, allChunks, partialAnalysis, iteration, lang, combinedContext);

    const tokenEstimate = estimateTokens(prompt);
    console.log(`\n[estimated tokens: ~${tokenEstimate}]`);

    const raw = await llm(prompt);
    const parsed = parseLLMResponse(raw);

    if (!parsed) {
      console.log("\nANSWER:\n");
      console.log(raw);
      return;
    }

    if (parsed.partial_analysis) {
      partialAnalysis = parsed.partial_analysis;
      console.log(`\n[partial analysis]: ${parsed.partial_analysis}`);
    }

    if (parsed.read_file) {
      const filePath = parsed.read_file;
      const resolvedFile = path.resolve(filePath);
      const resolvedProject = path.resolve(projectPath);
      if (!resolvedFile.startsWith(resolvedProject + path.sep) && resolvedFile !== resolvedProject) {
        console.log(`[read_file] Access denied: path outside project.`);
        continue;
      }
      console.log(`\n[read_file] Reading: ${filePath}`);
      try {
        const content = fs.readFileSync(resolvedFile, "utf-8");
        const lines = content.split("\n").slice(0, 300).join("\n");
        const fileChunk: Chunk = {
          file: filePath,
          lineStart: 1,
          lineEnd: Math.min(300, content.split("\n").length),
          symbolName: "(full file)",
          code: lines,
        };
        if (!visitedFiles.has(filePath)) {
          visitedFiles.add(filePath);
          allChunks.push(fileChunk);
        }
      } catch {
        console.log("Could not read file.");
      }
      continue;
    }

    if (!parsed.needs_more_context || parsed.answer) {
      console.log("\nFINAL ANSWER:\n");
      console.log(parsed.answer ?? raw);
      return;
    }

    if (parsed.search_terms.length === 0) {
      console.log("\nFINAL ANSWER:\n");
      console.log(parsed.partial_analysis ?? raw);
      return;
    }

    console.log(`\n[needs more context] Searching: ${parsed.search_terms.join(", ")}`);
    currentQuery = parsed.search_terms.join(" ");
  }

  console.log("\n[max iterations reached] Generating final answer...");
  const finalPrompt = buildIterativePrompt(question, allChunks, partialAnalysis, maxIterations, lang, combinedContext, true);

  const finalTokens = estimateTokens(finalPrompt);
  console.log(`\n[estimated tokens: ~${finalTokens}]`);

  const finalRaw = await llm(finalPrompt);
  const finalParsed = parseLLMResponse(finalRaw);
  console.log("\nFINAL ANSWER:\n");
  console.log(finalParsed?.answer ?? finalRaw);
}
