import { getProviderConnections } from "@/lib/localDb";
import { syncProviderConnectionModels } from "@/lib/modelSync";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

const state = global.__modelSyncScheduler ??= {
  timer: null,
  startupTimer: null,
  running: false,
};

function getIntervalMs() {
  const hours = Number.parseInt(process.env.MODEL_SYNC_INTERVAL_HOURS || "", 10);
  if (Number.isFinite(hours) && hours > 0) return hours * 60 * 60 * 1000;
  return DEFAULT_INTERVAL_MS;
}

async function getAutoSyncConnections() {
  const connections = await getProviderConnections();
  return connections.filter((connection) => {
    if (connection.isActive === false) return false;
    return connection.providerSpecificData?.autoSync !== false;
  });
}

export async function runModelSyncCycle() {
  if (state.running) {
    console.log("[ModelSync] Skipping cycle; previous run still active");
    return;
  }

  state.running = true;
  try {
    const connections = await getAutoSyncConnections();
    if (connections.length === 0) return;

    console.log(`[ModelSync] Starting cycle for ${connections.length} connection(s)`);
    const results = await Promise.allSettled(
      connections.map((connection) => syncProviderConnectionModels(connection.id))
    );
    const ok = results.filter((result) => result.status === "fulfilled" && result.value?.ok).length;
    console.log(`[ModelSync] Cycle complete: ${ok}/${connections.length} synced`);
  } catch (error) {
    console.log("[ModelSync] Cycle failed:", error.message);
  } finally {
    state.running = false;
  }
}

export function startModelSyncScheduler() {
  if (state.timer) return;

  const intervalMs = getIntervalMs();
  console.log(`[ModelSync] Scheduler started; interval ${intervalMs / 3_600_000}h`);

  state.startupTimer = setTimeout(() => {
    runModelSyncCycle().catch(() => {});
  }, 5000);
  state.startupTimer.unref?.();

  state.timer = setInterval(() => {
    runModelSyncCycle().catch(() => {});
  }, intervalMs);
  state.timer.unref?.();
}

export function stopModelSyncScheduler() {
  if (state.startupTimer) {
    clearTimeout(state.startupTimer);
    state.startupTimer = null;
  }
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}
