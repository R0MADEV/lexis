import { SearchResult } from "./searcher";

export interface Chunk {
  file: string;
  lineStart: number;
  lineEnd: number;
  symbolName: string;
  code: string;
}

export interface Prompt {
  chunks: Chunk[];
  question: string;
  formattedIterative: string;
}

export interface LLMResponse {
  needs_more_context: boolean;
  search_terms: string[];
  partial_analysis: string | null;
  answer: string | null;
  read_file?: string | null;
}

export interface LexisTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildPrompt(
  question: string,
  results: SearchResult[],
  options?: { lang?: string; gitContext?: string }
): Prompt {
  const chunks: Chunk[] = results.map((r) => ({
    file: r.symbol.file,
    lineStart: r.symbol.lineStart,
    lineEnd: r.symbol.lineEnd,
    symbolName: r.symbol.name,
    code: r.code,
  }));

  const lang = options?.lang ?? process.env["LEXIS_LANG"] ?? "en";
  const formattedIterative = formatPrompt(question, chunks, lang, true, options?.gitContext);

  return { chunks, question, formattedIterative };
}

export function buildIterativePrompt(
  question: string,
  allChunks: Chunk[],
  partialAnalysis: string | null,
  iteration: number,
  lang: string,
  gitContext?: string,
  forceFinal = false
): string {
  const contextBlock = allChunks
    .map((c) => `FILE: ${c.file} (lines ${c.lineStart}-${c.lineEnd})\nSYMBOL: ${c.symbolName}\nCODE:\n\`\`\`\n${c.code}\n\`\`\``)
    .join("\n\n---\n\n");

  const iterationNote = `Iteration ${iteration}. ${partialAnalysis ? `Previous analysis: ${partialAnalysis}` : ""}`;
  const gitSection = gitContext ? `\n\n${gitContext}` : "";

  return buildSystemPrompt(lang, true, forceFinal) +
    gitSection +
    `\n\n${iterationNote}\n\nRELEVANT CODE:\n\n${contextBlock}\n\nQUESTION: ${question}`;
}

export function parseLLMResponse(raw: string): LLMResponse | null {
  try {
    const jsonMatch = raw.match(/```json\s*([\s\S]+?)\s*```/) ?? raw.match(/(\{[\s\S]+\})/);
    if (!jsonMatch?.[1]) return null;
    return JSON.parse(jsonMatch[1]) as LLMResponse;
  } catch {
    return null;
  }
}

export function langInstruction(lang: string): string {
  if (lang === "en" || !lang) return "";
  const names: Record<string, string> = {
    es: "Spanish", fr: "French", de: "German", pt: "Portuguese",
    it: "Italian", ja: "Japanese", zh: "Chinese", ko: "Korean",
    ru: "Russian", ar: "Arabic", nl: "Dutch", pl: "Polish",
    tr: "Turkish", sv: "Swedish", da: "Danish", fi: "Finnish",
  };
  const name = names[lang] ?? lang.toUpperCase();
  return ` Respond in ${name}.`;
}

function formatPrompt(
  question: string,
  chunks: Chunk[],
  lang: string,
  iterative: boolean,
  gitContext?: string
): string {
  const contextBlock = chunks
    .map((c) => `FILE: ${c.file} (lines ${c.lineStart}-${c.lineEnd})\nSYMBOL: ${c.symbolName}\nCODE:\n\`\`\`\n${c.code}\n\`\`\``)
    .join("\n\n---\n\n");

  const gitSection = gitContext ? `\n\n${gitContext}` : "";
  return `${buildSystemPrompt(lang, iterative)}${gitSection}\n\nRELEVANT CODE:\n\n${contextBlock}\n\nQUESTION: ${question}`;
}

function buildSystemPrompt(lang: string, iterative: boolean, forceFinal = false): string {
  const respond = langInstruction(lang);

  if (!iterative) {
    return `You are an expert code analysis assistant. Analyze the following code and answer the question.${respond}`;
  }

  const contextInstruction = forceFinal
    ? `You have reached the final iteration. You MUST provide a complete answer now. Set needs_more_context: false and write the full answer in the "answer" field.`
    : `If you need more code to answer well, set needs_more_context: true and list the exact identifiers to search in search_terms.\nIf you need to see a full file, set the absolute path in read_file.\nIf you have enough context, set needs_more_context: false and write the complete answer in answer.`;

  const needsMoreValue = forceFinal ? "false" : "true or false";

  return `You are an expert code analysis assistant. Analyze the code and ALWAYS respond in this exact JSON format:

\`\`\`json
{
  "needs_more_context": ${needsMoreValue},
  "search_terms": ["term1", "term2"],
  "partial_analysis": "your partial analysis here or null",
  "answer": "your final answer here or null",
  "read_file": "absolute/path/to/file or null"
}
\`\`\`

${contextInstruction}${respond}`;
}
