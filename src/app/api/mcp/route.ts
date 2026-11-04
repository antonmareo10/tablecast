import { handleMcpPost } from "@/lib/mcp-server";

// The Tablecast MCP server (streamable HTTP, JSON answers, no sessions): Otari connects to it during research turns.
// A page read has a 10 s deadline, well inside Otari's 30 s limit per MCP tool call.
export const maxDuration = 30;

export async function POST(request: Request) {
  return handleMcpPost(request);
}

// This server opens no server-to-client stream, so GET (and DELETE, for sessions it never creates) are refused, as the
// streamable HTTP transport allows.
export function GET() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

export function DELETE() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}
