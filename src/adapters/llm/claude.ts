import Anthropic from "@anthropic-ai/sdk";
import { LexisTool } from "../../core/chunker";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}
const MODEL = process.env["LEXIS_MODEL_CLAUDE"] ?? "claude-sonnet-4-6";

const MAX_TOOL_RESULT_TOKENS = parseInt(process.env["LEXIS_MAX_TOOL_RESULT_TOKENS"] ?? "15000");
const MAX_TURNS = parseInt(process.env["LEXIS_MAX_TURNS"] ?? "8");

function truncateToolResult(text: string): string {
  const estimatedTokens = Math.ceil(text.length / 4);
  if (estimatedTokens <= MAX_TOOL_RESULT_TOKENS) return text;
  const maxChars = MAX_TOOL_RESULT_TOKENS * 4;
  return text.slice(0, maxChars) + `\n\n[... truncated, ${estimatedTokens - MAX_TOOL_RESULT_TOKENS} more tokens. Be more specific in your next query.]`;
}

export async function ask(prompt: string): Promise<string> {
  const message = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const block = message.content[0];
  if (block?.type === "text") return block.text;
  return "";
}

export async function askWithTools(
  systemPrompt: string,
  userMessage: string,
  tools: LexisTool[]
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  const toolDefs: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  let lastText = "";

  for (let i = 0; i < MAX_TURNS; i++) {
    let response;
    try {
      response = await getClient().messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        tools: toolDefs,
        messages,
      });
    } catch (err: unknown) {
      const error = err as { status?: number; message?: string };
      const msg = error.message ?? "";
      const isContextErr = error.status === 400 && /(context|token|too long|exceed)/i.test(msg);
      const isRateLimitErr = error.status === 429;
      if (isContextErr || isRateLimitErr) {
        const reason = isRateLimitErr ? "Rate limit hit (too many tokens per minute)" : "Context length exceeded";
        return lastText || `[${reason} — accumulated context is too large. Try a more specific question, set LEXIS_MAX_RESULTS=20, or LEXIS_MAX_TOOL_RESULT_TOKENS=8000.]`;
      }
      throw err;
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (textBlock?.type === "text" && textBlock.text) lastText = textBlock.text;

    if (response.stop_reason === "end_turn") {
      return lastText;
    }

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const tool = tools.find((t) => t.name === block.name);
          const result = tool
            ? await tool.execute(block.input as Record<string, unknown>)
            : "Tool not found";
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: truncateToolResult(result),
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
    } else {
      break;
    }
  }

  return lastText || "[No answer generated — max iterations reached]";
}
