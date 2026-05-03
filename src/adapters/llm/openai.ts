import OpenAI from "openai";
import { LexisTool } from "../../core/chunker";

// 👇 provider dinámico: openai, deepseek, gemini o groq
const PROVIDER = process.env["LEXIS_PROVIDER"] ?? "openai";

// 👇 cliente configurable
const client = new OpenAI({
  apiKey:
    PROVIDER === "deepseek"
      ? process.env["DEEPSEEK_API_KEY"]
      : PROVIDER === "gemini"
        ? process.env["GEMINI_API_KEY"]
        : PROVIDER === "groq"
          ? process.env["GROQ_API_KEY"]
          : process.env["OPENAI_API_KEY"],
  baseURL:
    PROVIDER === "deepseek"
      ? "https://api.deepseek.com"
      : PROVIDER === "gemini"
        ? "https://generativelanguage.googleapis.com/v1beta/openai/"
        : PROVIDER === "groq"
          ? "https://api.groq.com/openai/v1"
          : undefined,
});

// 👇 modelo dinámico
const MODEL =
  PROVIDER === "deepseek"
    ? process.env["LEXIS_MODEL_DEEPSEEK"] ?? "deepseek-chat"
    : PROVIDER === "gemini"
      ? process.env["LEXIS_MODEL_GEMINI"] ?? "gemini-2.5-flash"
      : PROVIDER === "groq"
        ? process.env["LEXIS_MODEL_GROQ"] ?? "llama-3.3-70b-versatile"
        : process.env["LEXIS_MODEL_OPENAI"] ?? "gpt-4o";

const MAX_TOOL_RESULT_TOKENS = parseInt(process.env["LEXIS_MAX_TOOL_RESULT_TOKENS"] ?? "15000");
const MAX_TURNS = parseInt(process.env["LEXIS_MAX_TURNS"] ?? "8");

function truncateToolResult(text: string): string {
  const estimatedTokens = Math.ceil(text.length / 4);
  if (estimatedTokens <= MAX_TOOL_RESULT_TOKENS) return text;
  const maxChars = MAX_TOOL_RESULT_TOKENS * 4;
  return text.slice(0, maxChars) + `\n\n[... truncated, ${estimatedTokens - MAX_TOOL_RESULT_TOKENS} more tokens. Be more specific in your next query.]`;
}

export async function ask(prompt: string): Promise<string> {
  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 4096,
  });

  return response.choices[0]?.message?.content ?? "";
}

export async function askWithTools(
  systemPrompt: string,
  userMessage: string,
  tools: LexisTool[]
): Promise<string> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const toolDefs: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));

  let lastText = "";

  for (let i = 0; i < MAX_TURNS; i++) {
    let response;
    try {
      response = await client.chat.completions.create({
        model: MODEL,
        messages,
        tools: toolDefs,
        tool_choice: "auto",
        max_tokens: 4096,
      });
    } catch (err: unknown) {
      const error = err as { code?: string; status?: number; message?: string };
      const isContextErr = error.code === "context_length_exceeded";
      const isRateLimitErr = error.status === 429 || error.code === "rate_limit_exceeded";
      if (isContextErr || isRateLimitErr) {
        const reason = isRateLimitErr ? "Rate limit hit (too many tokens per minute)" : "Context length exceeded";
        return lastText || `[${reason} — accumulated context is too large. Try a more specific question, set LEXIS_MAX_RESULTS=20, or LEXIS_MAX_TOOL_RESULT_TOKENS=8000.]`;
      }
      throw err;
    }

    const msg = response.choices[0]?.message;
    if (!msg) break;

    if (msg.content) lastText = msg.content;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return lastText;
    }

    messages.push(msg);

    for (const toolCall of msg.tool_calls) {
      if (toolCall.type !== "function") continue;
      const fnToolCall = toolCall as OpenAI.Chat.ChatCompletionMessageFunctionToolCall;
      const tool = tools.find((t) => t.name === fnToolCall.function.name);
      let result: string;
      try {
        const args = JSON.parse(fnToolCall.function.arguments) as Record<string, unknown>;
        result = tool ? await tool.execute(args) : "Tool not found";
      } catch {
        result = "Failed to parse tool arguments";
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: truncateToolResult(result),
      });
    }
  }

  return lastText || "[No answer generated — max iterations reached]";
}