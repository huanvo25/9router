import { handleOpenAIPassthrough } from "@/sse/handlers/openaiPassthrough.js";

export async function OPTIONS() {
  return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "*" } });
}

export async function POST(request) {
  return await handleOpenAIPassthrough(request, "realtime/sessions");
}
