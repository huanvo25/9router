import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";
import { getSettings } from "@/lib/localDb";

const DEFAULT_PASSWORD = "123456";

function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(DATA_DIR, "jwt-secret");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

const SECRET = new TextEncoder().encode(loadJwtSecret());
const AUTH_TOKEN_COOKIE = "auth_token";
const DEVICE_ID_COOKIE = "auth_device_id";
const DEFAULT_SESSION_DAYS = 365;
const SESSION_STORE_FILE = path.join(DATA_DIR, "auth", "dashboard-sessions.json");

function getSessionMaxAgeSeconds() {
  const raw = process.env.AUTH_SESSION_DAYS || process.env.DASHBOARD_SESSION_DAYS;
  const days = Number(raw);
  if (Number.isFinite(days) && days > 0) {
    return Math.floor(Math.min(days, 3650) * 24 * 60 * 60);
  }
  return DEFAULT_SESSION_DAYS * 24 * 60 * 60;
}

const SESSION_MAX_AGE_SECONDS = getSessionMaxAgeSeconds();

function getCookieValue(cookieStore, name) {
  try {
    return cookieStore?.get?.(name)?.value || "";
  } catch {
    return "";
  }
}

function readSessionStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_STORE_FILE, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.sessions && typeof parsed.sessions === "object") {
      return parsed;
    }
  } catch {}
  return { version: 1, sessions: {} };
}

function pruneSessionStore(store, now = Date.now()) {
  const sessions = {};
  for (const [sid, session] of Object.entries(store.sessions || {})) {
    const expiresAt = Date.parse(session?.expiresAt || "");
    const revokedAt = Date.parse(session?.revokedAt || "");
    const expired = Number.isFinite(expiresAt) && expiresAt <= now;
    const revokedLongAgo = Number.isFinite(revokedAt) && now - revokedAt > 7 * 24 * 60 * 60 * 1000;
    if (!expired && !revokedLongAgo) sessions[sid] = session;
  }
  return { version: 1, sessions };
}

function writeSessionStore(store) {
  const dir = path.dirname(SESSION_STORE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${SESSION_STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pruneSessionStore(store), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SESSION_STORE_FILE);
}

function sanitizeClaims(claims = {}) {
  const {
    authenticated,
    iat,
    exp,
    nbf,
    jti,
    sid,
    deviceId,
    ...rest
  } = claims || {};
  return rest;
}

function createSessionRecord({ sid, deviceId, claims, expiresAt, request }) {
  return {
    sid,
    deviceId,
    claims: sanitizeClaims(claims),
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    expiresAt,
    userAgent: request?.headers?.get?.("user-agent") || null,
    ip: request?.headers?.get?.("x-9r-real-ip") || request?.headers?.get?.("x-forwarded-for")?.split(",")[0]?.trim() || null,
  };
}

function saveSessionRecord(record) {
  const store = readSessionStore();
  store.sessions[record.sid] = record;
  writeSessionStore(store);
}

function getSessionRecord(sid) {
  if (!sid) return null;
  return readSessionStore().sessions?.[sid] || null;
}

function touchSessionRecord(sid) {
  const store = readSessionStore();
  const session = store.sessions?.[sid];
  if (!session) return;
  const lastSeen = Date.parse(session.lastSeenAt || "");
  if (Number.isFinite(lastSeen) && Date.now() - lastSeen < 60 * 60 * 1000) return;
  session.lastSeenAt = new Date().toISOString();
  writeSessionStore(store);
}

function revokeSessionRecord(sid, deviceId) {
  const store = readSessionStore();
  const session = store.sessions?.[sid];
  if (!session) return;
  if (deviceId && session.deviceId !== deviceId) return;
  session.revokedAt = new Date().toISOString();
  writeSessionStore(store);
}

export function shouldUseSecureCookie(request) {
  const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
  const forwardedProto = request?.headers?.get?.("x-forwarded-proto");
  const isHttpsRequest = forwardedProto === "https";
  return forceSecureCookie || isHttpsRequest;
}

export async function createDashboardAuthToken(claims = {}) {
  return new SignJWT({ authenticated: true, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS)
    .sign(SECRET);
}

export async function verifyDashboardAuthToken(token, deviceId = "") {
  if (!token) return false;
  return !!(await getDashboardAuthSession(token, deviceId));
}

export async function getDashboardAuthSession(token, deviceId = "") {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    if (!payload.sid && !payload.deviceId) return payload;
    if (!payload.sid || !payload.deviceId || payload.deviceId !== deviceId) return null;

    const record = getSessionRecord(payload.sid);
    if (!record || record.revokedAt || record.deviceId !== payload.deviceId) return null;
    const expiresAt = Date.parse(record.expiresAt || "");
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return null;

    touchSessionRecord(payload.sid);
    return payload;
  } catch {
    return null;
  }
}

export async function setDashboardAuthCookie(cookieStore, request, claims = {}) {
  const deviceId = getCookieValue(cookieStore, DEVICE_ID_COOKIE) || crypto.randomUUID();
  const previousToken = getCookieValue(cookieStore, AUTH_TOKEN_COOKIE);
  const sid = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  const token = await createDashboardAuthToken({ ...sanitizeClaims(claims), sid, deviceId });
  const options = {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };

  if (previousToken) await revokeDashboardAuthSession(previousToken, deviceId);
  saveSessionRecord(createSessionRecord({ sid, deviceId, claims, expiresAt, request }));
  cookieStore.set(DEVICE_ID_COOKIE, deviceId, options);
  cookieStore.set(AUTH_TOKEN_COOKIE, token, options);
  return { token, sid, deviceId, expiresAt };
}

export function isLegacyDashboardAuthSession(session) {
  return !!session?.authenticated && !session?.sid && !session?.deviceId;
}

export async function renewLegacyDashboardAuthCookie(cookieStore, request, session) {
  if (!isLegacyDashboardAuthSession(session)) return null;
  return await setDashboardAuthCookie(cookieStore, request, sanitizeClaims(session));
}

export async function revokeDashboardAuthSession(token, deviceId = "") {
  const session = await getDashboardAuthSession(token, deviceId);
  if (session?.sid) revokeSessionRecord(session.sid, deviceId);
}

export async function clearDashboardAuthCookie(cookieStore) {
  const token = getCookieValue(cookieStore, AUTH_TOKEN_COOKIE);
  const deviceId = getCookieValue(cookieStore, DEVICE_ID_COOKIE);
  await revokeDashboardAuthSession(token, deviceId);
  cookieStore.delete(AUTH_TOKEN_COOKIE);
}

// Verify the current dashboard password (re-auth for sensitive actions).
export async function verifyDashboardPassword(password) {
  if (typeof password !== "string" || !password) return false;
  const settings = await getSettings();
  const storedHash = settings?.password;
  if (storedHash) return bcrypt.compare(password, storedHash);
  const initialPassword = process.env.INITIAL_PASSWORD || DEFAULT_PASSWORD;
  return password === initialPassword;
}
