const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const httpProxy = require("http-proxy");

const origCreate = http.createServer.bind(http);
const realtimeProxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });

const DEFAULT_PROVIDER = "cliproxyapi";
const OPENAI_BASES = {
  openai: "https://api.openai.com/v1",
  cliproxyapi: "https://api.cliproxyapi.com/v1",
};

function defaultDataDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router");
  }
  return path.join(os.homedir(), ".9router");
}

function dataDir() {
  return process.env.DATA_DIR || defaultDataDir();
}

function dbFile() {
  return path.join(dataDir(), "db", "data.sqlite");
}

function parseJson(raw, fallback = {}) {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

function openDb() {
  const file = dbFile();
  if (!fs.existsSync(file)) return null;
  try {
    const Database = require("better-sqlite3");
    return new Database(file, { readonly: true, fileMustExist: true });
  } catch (error) {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    return {
      prepare(sql) {
        const stmt = db.prepare(sql);
        return {
          get(...params) {
            return stmt.get(...params);
          },
        };
      },
      close() {
        db.close();
      },
    };
  }
}

function readSettings(db) {
  const row = db.prepare("SELECT data FROM settings WHERE id = 1").get();
  return parseJson(row && row.data, {});
}

function isValidRouterKey(db, key) {
  if (!key) return false;
  const row = db.prepare("SELECT isActive FROM apiKeys WHERE key = ?").get(key);
  return !!row && (row.isActive === 1 || row.isActive === true);
}

function extractBearer(req) {
  const auth = req.headers.authorization || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

function rowToConnection(row) {
  if (!row) return null;
  return {
    ...parseJson(row.data, {}),
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    priority: row.priority,
    isActive: row.isActive === 1 || row.isActive === true,
  };
}

function resolveProviderAndModel(url) {
  const explicitProvider = url.searchParams.get("provider") || DEFAULT_PROVIDER;
  const rawModel = url.searchParams.get("model") || "";
  if (rawModel.includes("/")) {
    const [provider, ...rest] = rawModel.split("/");
    return { provider, model: rest.join("/") };
  }
  return { provider: explicitProvider, model: rawModel };
}

function getConnection(db, provider) {
  const row = db.prepare("SELECT * FROM providerConnections WHERE provider = ? AND isActive = 1 ORDER BY COALESCE(priority, 999) ASC LIMIT 1").get(provider);
  return rowToConnection(row);
}

function stripKnownOpenAIPath(raw) {
  return String(raw || "").trim().replace(/\/+$/, "").replace(/\/(chat\/completions|responses|embeddings|images\/(generations|edits|variations)|audio\/(speech|transcriptions|translations)|realtime\/(sessions|transcription_sessions)|realtime|files|batches|vector_stores|assistants|threads|uploads|fine_tuning\/jobs|moderations|models)$/i, "");
}

function providerBaseUrl(provider, connection) {
  const override = stripKnownOpenAIPath(connection && connection.providerSpecificData && connection.providerSpecificData.baseUrl);
  return override || OPENAI_BASES[provider] || "";
}

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}`);
  socket.destroy();
}

function handleRealtimeUpgrade(req, socket, head) {
  let localUrl;
  try {
    localUrl = new URL(req.url, "http://127.0.0.1");
  } catch {
    return false;
  }
  if (localUrl.pathname !== "/v1/realtime" && localUrl.pathname !== "/api/v1/realtime") return false;

  let db;
  try {
    db = openDb();
    if (!db) return rejectUpgrade(socket, 503, "9Router DB unavailable"), true;

    const settings = readSettings(db);
    if (settings.requireApiKey) {
      const routerKey = extractBearer(req) || req.headers["x-api-key"];
      if (!isValidRouterKey(db, routerKey)) return rejectUpgrade(socket, 401, "Invalid API key"), true;
    }

    const { provider, model } = resolveProviderAndModel(localUrl);
    const connection = getConnection(db, provider);
    if (!connection) return rejectUpgrade(socket, 404, `No active ${provider} connection`), true;

    const upstreamKey = connection.apiKey || connection.accessToken;
    if (!upstreamKey) return rejectUpgrade(socket, 401, `No upstream token for ${provider}`), true;

    const base = providerBaseUrl(provider, connection);
    if (!base) return rejectUpgrade(socket, 400, `No realtime base URL for ${provider}`), true;

    const targetOrigin = base.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
    const target = new URL(targetOrigin);
    const upstreamPath = new URL(`${targetOrigin}/realtime`);
    for (const [key, value] of localUrl.searchParams.entries()) {
      if (key === "provider") continue;
      if (key === "model" && model) upstreamPath.searchParams.set("model", model);
      else upstreamPath.searchParams.set(key, value);
    }
    if (model && !upstreamPath.searchParams.has("model")) upstreamPath.searchParams.set("model", model);

    req.url = `${upstreamPath.pathname}${upstreamPath.search}`;
    req.headers.host = target.host;
    req.headers.authorization = `Bearer ${upstreamKey}`;
    req.headers["openai-beta"] = req.headers["openai-beta"] || "realtime=v1";
    delete req.headers["x-9router-provider"];
    delete req.headers["x-provider"];

    realtimeProxy.ws(req, socket, head, { target: target.origin });
    return true;
  } catch (error) {
    rejectUpgrade(socket, 502, error && error.message ? error.message : "Realtime proxy error");
    return true;
  } finally {
    try { db && db.close(); } catch { }
  }
}

realtimeProxy.on("error", (error, req, socket) => {
  if (socket && !socket.destroyed) rejectUpgrade(socket, 502, error && error.message ? error.message : "Realtime upstream error");
});

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    req.headers["x-9r-real-ip"] = ip;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    return handler(req, res);
  };
  const server = origCreate(...rest, wrapped);
  server.on("upgrade", (req, socket, head) => {
    handleRealtimeUpgrade(req, socket, head);
  });
  return server;
};

require("./server.js");
