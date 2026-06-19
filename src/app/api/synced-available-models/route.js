import { NextResponse } from "next/server";
import { getAllSyncedAvailableModels, getSyncedAvailableModels } from "@/models";

export const dynamic = "force-dynamic";

// GET /api/synced-available-models?provider=<id>
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");

    if (provider) {
      const models = await getSyncedAvailableModels(provider);
      return NextResponse.json({ models });
    }

    const models = await getAllSyncedAvailableModels();
    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching synced models:", error);
    return NextResponse.json({ error: "Failed to fetch synced models" }, { status: 500 });
  }
}

