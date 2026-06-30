import { handleOpenAIPassthrough } from "@/sse/handlers/openaiPassthrough.js";

function endpoint(params) {
  const suffix = Array.isArray(params?.path) && params.path.length ? "/" + params.path.join("/") : "";
  return "vector_stores" + suffix;
}

export async function OPTIONS() {
  return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS", "Access-Control-Allow-Headers": "*" } });
}

export async function GET(request, { params }) {
  return await handleOpenAIPassthrough(request, endpoint(await params));
}

export async function POST(request, { params }) {
  return await handleOpenAIPassthrough(request, endpoint(await params));
}

export async function PATCH(request, { params }) {
  return await handleOpenAIPassthrough(request, endpoint(await params));
}

export async function DELETE(request, { params }) {
  return await handleOpenAIPassthrough(request, endpoint(await params));
}
