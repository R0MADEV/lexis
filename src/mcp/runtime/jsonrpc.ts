// Minimal JSON-RPC 2.0 helpers for the MCP stdio transport.
// All diagnostic output goes to stderr so it doesn't corrupt the protocol stream.

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: unknown;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: number | string | null; result: unknown }
  | { jsonrpc: "2.0"; id: number | string | null; error: { code: number; message: string } };

export function send(msg: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

export function ok(id: number | string | null, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

export function err(id: number | string | null, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

export const log = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");
