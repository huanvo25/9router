import { NextResponse } from "next/server";
import { getProviderConnectionById, updateProviderConnection } from "@/models";
import { syncProviderConnectionModels } from "@/lib/modelSync";

export const dynamic = "force-dynamic";

// POST /api/providers/[id]/sync-models - Fetch and cache provider model list
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const result = await syncProviderConnectionModels(id);

    if (!result.ok) {
      const connection = await getProviderConnectionById(id);
      if (connection) {
        await updateProviderConnection(id, {
          providerSpecificData: {
            ...(connection.providerSpecificData || {}),
            lastModelSyncError: result.error || "Failed to sync models",
            lastModelSyncAt: new Date().toISOString(),
          },
        });
      }
      return NextResponse.json(
        { error: result.error || "Failed to sync models", provider: result.provider },
        { status: result.status || 500 }
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.log("Error syncing provider models:", error);
    return NextResponse.json({ error: "Failed to sync models" }, { status: 500 });
  }
}

