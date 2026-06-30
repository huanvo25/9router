import { NextResponse } from "next/server";
import { getCustomModels, addCustomModel, deleteCustomModel, clearCustomModelsForProvider, clearAliasesForProvider, clearSyncedAvailableModels } from "@/models";

export const dynamic = "force-dynamic";

// GET /api/models/custom - List all custom models
export async function GET() {
  try {
    const models = await getCustomModels();
    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching custom models:", error);
    return NextResponse.json({ error: "Failed to fetch custom models" }, { status: 500 });
  }
}

// POST /api/models/custom - Add custom model
export async function POST(request) {
  try {
    const { providerAlias, id, type, name } = await request.json();
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    const added = await addCustomModel({ providerAlias, id, type: type || "llm", name });
    return NextResponse.json({ success: true, added });
  } catch (error) {
    console.log("Error adding custom model:", error);
    return NextResponse.json({ error: "Failed to add custom model" }, { status: 500 });
  }
}

// DELETE /api/models/custom?providerAlias=xxx&id=yyy&type=zzz
// DELETE /api/models/custom?providerAlias=xxx&all=1[&clearSynced=1]  — clear all models for a provider
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const id = searchParams.get("id");
    const type = searchParams.get("type") || "llm";
    const all = searchParams.get("all") === "1";
    if (!providerAlias) {
      return NextResponse.json({ error: "providerAlias required" }, { status: 400 });
    }

    if (all) {
      // Bulk clear: custom models + aliases (+ optionally synced cache) for this provider
      await clearCustomModelsForProvider(providerAlias, type !== "all" ? type : null);
      await clearAliasesForProvider(providerAlias);
      if (searchParams.get("clearSynced") === "1") {
        await clearSyncedAvailableModels(providerAlias);
      }
      return NextResponse.json({ success: true, cleared: true });
    }

    if (!id) {
      return NextResponse.json({ error: "id required (or all=1 for bulk)" }, { status: 400 });
    }
    await deleteCustomModel({ providerAlias, id, type });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting custom model:", error);
    return NextResponse.json({ error: "Failed to delete custom model" }, { status: 500 });
  }
}
