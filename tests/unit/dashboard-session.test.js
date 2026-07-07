import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir;

function makeCookieStore(initial = {}) {
  const jar = new Map(Object.entries(initial));
  return {
    get: vi.fn((name) => (jar.has(name) ? { value: jar.get(name) } : undefined)),
    set: vi.fn((name, value) => jar.set(name, value)),
    delete: vi.fn((name) => jar.delete(name)),
    value(name) {
      return jar.get(name);
    },
  };
}

function makeRequest(headers = {}) {
  return {
    headers: new Headers(headers),
  };
}

async function loadModule() {
  vi.resetModules();
  process.env.DATA_DIR = tempDir;
  process.env.AUTH_SESSION_DAYS = "30";
  return await import("../../src/lib/auth/dashboardSession.js");
}

describe("dashboard session persistence", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-dashboard-session-"));
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    delete process.env.AUTH_SESSION_DAYS;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("creates a durable token bound to the current device cookie", async () => {
    const { setDashboardAuthCookie, verifyDashboardAuthToken } = await loadModule();
    const cookieStore = makeCookieStore();

    await setDashboardAuthCookie(cookieStore, makeRequest({ "user-agent": "vitest" }), { oidcEmail: "user@example.com" });

    const token = cookieStore.value("auth_token");
    const deviceId = cookieStore.value("auth_device_id");
    expect(token).toBeTruthy();
    expect(deviceId).toBeTruthy();
    expect(await verifyDashboardAuthToken(token, deviceId)).toBe(true);
    expect(await verifyDashboardAuthToken(token, "other-device")).toBe(false);
  });

  it("revokes only the current device session on logout", async () => {
    const { setDashboardAuthCookie, clearDashboardAuthCookie, verifyDashboardAuthToken } = await loadModule();
    const first = makeCookieStore();
    const second = makeCookieStore();

    await setDashboardAuthCookie(first, makeRequest());
    await setDashboardAuthCookie(second, makeRequest());
    const firstToken = first.value("auth_token");
    const firstDevice = first.value("auth_device_id");
    const secondToken = second.value("auth_token");
    const secondDevice = second.value("auth_device_id");

    await clearDashboardAuthCookie(first);

    expect(await verifyDashboardAuthToken(firstToken, firstDevice)).toBe(false);
    expect(await verifyDashboardAuthToken(secondToken, secondDevice)).toBe(true);
  });

  it("accepts legacy signed tokens without device metadata", async () => {
    const { createDashboardAuthToken, verifyDashboardAuthToken } = await loadModule();
    const token = await createDashboardAuthToken({ oidc: false });

    expect(await verifyDashboardAuthToken(token)).toBe(true);
  });
});
