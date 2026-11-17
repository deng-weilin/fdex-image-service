import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { getConfig } from "./config.js";
import { openDatabase } from "./database.js";
import { hashPassword, randomToken, tokenHash, uuid, verifyPassword } from "./security.js";
import { HttpError, ImageService } from "./service.js";

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"]
]);

function isoNow() {
  return new Date().toISOString();
}

function parseCookies(header = "") {
  const result = {};
  for (const part of String(header).split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    result[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim());
  }
  return result;
}

function sessionCookie(token, maxAgeSeconds, secure) {
  return `session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

function clearSessionCookie(secure) {
  return `session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

function securityHeaders() {
  return {
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'"
    ].join("; "),
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()"
  };
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

function sendError(response, error) {
  if (error instanceof HttpError) {
    if (error.code === "rate_limited") response.setHeader("retry-after", String(error.details?.retryAfterSeconds || 1));
    sendJson(response, error.status, { error: error.code, message: error.message, details: error.details });
    return;
  }
  console.error(error);
  sendJson(response, 500, { error: "internal_error", message: "服务端发生错误" });
}

function createRateLimiter(limit, windowMs, trustProxy) {
  const buckets = new Map();
  return function consume(request, scope) {
    const now = Date.now();
    const forwarded = trustProxy ? String(request.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
    const clientAddress = forwarded || request.socket.remoteAddress || "unknown";
    const key = `${clientAddress}:${scope}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      throw new HttpError(429, "rate_limited", "请求过于频繁，请稍后再试", { retryAfterSeconds });
    }
    if (buckets.size > 1000) {
      for (const [bucketKey, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(bucketKey);
      }
    }
  };
}

async function readJson(request, maxBytes = 13 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "request_too_large", "请求体过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "请求体必须是有效 JSON");
  }
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at
  };
}

function safeFilename(name) {
  return String(name || "image").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

function streamFile(response, filePath, mimeType, downloadName = "") {
  if (!fs.existsSync(filePath)) throw new HttpError(404, "file_not_found", "文件不存在");
  const stat = fs.statSync(filePath);
  const headers = {
    ...securityHeaders(),
    "content-type": mimeType,
    "content-length": stat.size,
    "cache-control": "private, max-age=60"
  };
  if (mimeType.includes("svg")) {
    headers["content-security-policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
  }
  if (downloadName) headers["content-disposition"] = `attachment; filename="${safeFilename(downloadName)}"`;
  response.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(response);
}

function createAuth(db, config) {
  function createSession(userId) {
    const token = randomToken();
    const createdAt = isoNow();
    const expiresAt = new Date(Date.now() + config.sessionDays * 86_400_000).toISOString();
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(tokenHash(token), userId, expiresAt, createdAt);
    return { token, maxAgeSeconds: config.sessionDays * 86_400 };
  }

  function authenticate(request) {
    const authorization = String(request.headers.authorization || "");
    if (authorization.startsWith("Bearer ")) {
      const rawToken = authorization.slice(7).trim();
      const row = db.prepare(`
        SELECT u.* FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?
      `).get(tokenHash(rawToken));
      if (row) {
        db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?").run(isoNow(), tokenHash(rawToken));
        return { user: row, authType: "api_token" };
      }
    }
    const cookie = parseCookies(request.headers.cookie).session;
    if (cookie) {
      const row = db.prepare(`
        SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?
      `).get(tokenHash(cookie));
      if (row && row.expires_at > isoNow()) return { user: row, authType: "session" };
      if (row) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(cookie));
    }
    return null;
  }

  function requireAuth(request) {
    const auth = authenticate(request);
    if (!auth) throw new HttpError(401, "authentication_required", "请先登录");
    return auth;
  }

  return { createSession, authenticate, requireAuth };
}

export function createServerApplication(options = {}) {
  const config = getConfig(options);
  const db = openDatabase(config);
  const service = new ImageService(db, config);
  const auth = createAuth(db, config);
  const authRateLimiter = createRateLimiter(config.authRateLimitMax, config.authRateLimitWindowMs, config.trustProxy);
  service.start();

  function requireAdmin(request) {
    const current = auth.requireAuth(request);
    if (current.user.role !== "admin") throw new HttpError(403, "admin_required", "需要管理员权限");
    return current;
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, config.appOrigin);
      const method = request.method || "GET";
      const pathname = decodeURIComponent(url.pathname);

      if (method === "GET" && pathname === "/api/health") {
        const provider = service.providerStatus();
        sendJson(response, 200, {
          ok: true,
          service: "fdex-image-service",
          providerMode: service.config.providerMode,
          providerReady: provider.ready
        });
        return;
      }

      if (method === "GET" && pathname === "/api/auth/session") {
        const current = auth.authenticate(request);
        sendJson(response, 200, {
          authenticated: Boolean(current),
          user: current ? publicUser(current.user) : null,
          features: {
            allowRegistration: config.allowRegistration,
            demoAccountsEnabled: config.seedDemoAccounts
          }
        });
        return;
      }

      if (method === "POST" && pathname === "/api/auth/register") {
        authRateLimiter(request, "register");
        if (!config.allowRegistration) throw new HttpError(403, "registration_disabled", "当前未开放自主注册");
        const body = await readJson(request);
        const username = String(body.username || "").trim().toLowerCase();
        const password = String(body.password || "");
        const displayName = String(body.displayName || username).trim();
        if (!/^[a-z0-9_]{3,32}$/.test(username)) {
          throw new HttpError(422, "validation_error", "账号需为 3-32 位字母、数字或下划线");
        }
        if (password.length < 8 || password.length > 128) {
          throw new HttpError(422, "validation_error", "密码长度需为 8-128 位");
        }
        if (!displayName || displayName.length > 60) throw new HttpError(422, "validation_error", "显示名称无效");
        if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) {
          throw new HttpError(409, "username_exists", "账号已存在");
        }
        const id = uuid();
        const now = isoNow();
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'member', ?)")
            .run(id, username, displayName, hashPassword(password), now);
          db.prepare("INSERT INTO wallets (user_id, available, reserved, spent, updated_at) VALUES (?, ?, 0, 0, ?)")
            .run(id, config.initialCredits, now);
          db.prepare(`
            INSERT INTO transactions (
              id, user_id, job_id, type, available_delta, reserved_delta, spent_delta,
              available_after, reserved_after, spent_after, description, actor_id, created_at
            ) VALUES (?, ?, NULL, 'grant', ?, 0, 0, ?, 0, 0, '初始课堂体验额度', ?, ?)
          `).run(uuid(), id, config.initialCredits, config.initialCredits, id, now);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
        const session = auth.createSession(id);
        response.setHeader("set-cookie", sessionCookie(session.token, session.maxAgeSeconds, config.secureCookies));
        sendJson(response, 201, { user: publicUser(row) });
        return;
      }

      if (method === "POST" && pathname === "/api/auth/login") {
        authRateLimiter(request, "login");
        const body = await readJson(request);
        const username = String(body.username || "").trim().toLowerCase();
        const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
        if (!row || !verifyPassword(String(body.password || ""), row.password_hash)) {
          throw new HttpError(401, "invalid_credentials", "账号或密码错误");
        }
        const session = auth.createSession(row.id);
        response.setHeader("set-cookie", sessionCookie(session.token, session.maxAgeSeconds, config.secureCookies));
        sendJson(response, 200, { user: publicUser(row) });
        return;
      }

      if (method === "POST" && pathname === "/api/auth/logout") {
        const raw = parseCookies(request.headers.cookie).session;
        if (raw) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(raw));
        response.setHeader("set-cookie", clearSessionCookie(config.secureCookies));
        sendJson(response, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/api/account/password") {
        const current = auth.requireAuth(request);
        authRateLimiter(request, "change-password");
        const body = await readJson(request);
        service.changePassword(current.user.id, body.currentPassword, body.newPassword);
        response.setHeader("set-cookie", clearSessionCookie(config.secureCookies));
        sendJson(response, 200, { ok: true, reauthRequired: true });
        return;
      }

      if (method === "GET" && pathname === "/api/me") {
        const current = auth.requireAuth(request);
        sendJson(response, 200, {
          user: publicUser(current.user),
          wallet: service.wallet(current.user.id),
          pricing: service.pricing(),
          providerMode: service.config.providerMode,
          providerReady: service.providerStatus().ready,
          mcpServerPath: path.join(config.rootDir, "mcp", "server.js")
        });
        return;
      }

      if (method === "GET" && pathname === "/api/pricing") {
        sendJson(response, 200, service.pricing());
        return;
      }

      if (method === "GET" && pathname === "/api/wallet") {
        const current = auth.requireAuth(request);
        sendJson(response, 200, service.wallet(current.user.id));
        return;
      }

      if (method === "GET" && pathname === "/api/wallet/transactions") {
        const current = auth.requireAuth(request);
        sendJson(response, 200, { transactions: service.transactions(current.user.id, url.searchParams.get("limit") || 100) });
        return;
      }

      if (method === "GET" && pathname === "/api/assets") {
        const current = auth.requireAuth(request);
        sendJson(response, 200, { assets: service.listAssets(current.user.id) });
        return;
      }

      if (method === "POST" && pathname === "/api/assets") {
        const current = auth.requireAuth(request);
        sendJson(response, 201, { asset: service.createAsset(current.user.id, await readJson(request)) });
        return;
      }

      if (method === "POST" && pathname === "/api/assets/load-sample") {
        const current = auth.requireAuth(request);
        sendJson(response, 200, { assets: service.loadSampleAssets(current.user.id) });
        return;
      }

      const assetContent = pathname.match(/^\/api\/assets\/([^/]+)\/content$/);
      if (method === "GET" && assetContent) {
        const current = auth.requireAuth(request);
        const asset = service.getAsset(current.user.id, assetContent[1]);
        streamFile(response, asset.storage_path, asset.mime_type, url.searchParams.has("download") ? asset.original_name : "");
        return;
      }

      if (method === "GET" && pathname === "/api/drawing-specs") {
        const current = auth.requireAuth(request);
        sendJson(response, 200, { specs: service.listSpecs(current.user.id) });
        return;
      }

      if (method === "POST" && pathname === "/api/drawing-specs") {
        const current = auth.requireAuth(request);
        sendJson(response, 201, { spec: service.createSpec(current.user.id, await readJson(request)) });
        return;
      }

      if (method === "GET" && pathname === "/api/image-jobs") {
        const current = auth.requireAuth(request);
        sendJson(response, 200, { jobs: service.listJobs(current.user.id) });
        return;
      }

      if (method === "POST" && pathname === "/api/image-jobs") {
        const current = auth.requireAuth(request);
        const result = service.createJob(current.user.id, await readJson(request));
        sendJson(response, result.duplicate ? 200 : 201, result);
        return;
      }

      const jobMatch = pathname.match(/^\/api\/image-jobs\/([^/]+)$/);
      if (method === "GET" && jobMatch) {
        const current = auth.requireAuth(request);
        sendJson(response, 200, { job: service.getJob(current.user.id, jobMatch[1]) });
        return;
      }

      if (method === "GET" && pathname === "/api/images") {
        const current = auth.requireAuth(request);
        sendJson(response, 200, { images: service.listImages(current.user.id) });
        return;
      }

      const versionsMatch = pathname.match(/^\/api\/images\/([^/]+)\/versions$/);
      if (method === "GET" && versionsMatch) {
        const current = auth.requireAuth(request);
        sendJson(response, 200, { versions: service.imageVersions(current.user.id, versionsMatch[1]) });
        return;
      }

      const imageContentMatch = pathname.match(/^\/api\/images\/([^/]+)\/content$/);
      if (method === "GET" && imageContentMatch) {
        const current = auth.requireAuth(request);
        const image = service.getImage(current.user.id, imageContentMatch[1]);
        const extension = path.extname(image.storage_path);
        const name = `image-v${image.version_number}${extension}`;
        streamFile(response, image.storage_path, image.mime_type, url.searchParams.has("download") ? name : "");
        return;
      }

      const imageMatch = pathname.match(/^\/api\/images\/([^/]+)$/);
      if (method === "GET" && imageMatch) {
        const current = auth.requireAuth(request);
        sendJson(response, 200, { image: service.getImage(current.user.id, imageMatch[1]) });
        return;
      }

      if (method === "GET" && pathname === "/api/tokens") {
        const current = auth.requireAuth(request);
        const tokens = db.prepare("SELECT token_hash, name, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC")
          .all(current.user.id)
          .map((row) => ({ id: row.token_hash.slice(0, 12), name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at }));
        sendJson(response, 200, { tokens });
        return;
      }

      if (method === "POST" && pathname === "/api/tokens") {
        const current = auth.requireAuth(request);
        const body = await readJson(request);
        const name = String(body.name || "WorkBuddy").trim().slice(0, 80);
        if (!name) throw new HttpError(422, "validation_error", "令牌名称不能为空");
        const token = randomToken("wb_");
        db.prepare("INSERT INTO api_tokens (token_hash, user_id, name, created_at) VALUES (?, ?, ?, ?)")
          .run(tokenHash(token), current.user.id, name, isoNow());
        sendJson(response, 201, { token, name, message: "令牌只显示一次" });
        return;
      }

      if (method === "DELETE" && pathname.startsWith("/api/tokens/")) {
        const current = auth.requireAuth(request);
        const prefix = pathname.split("/").pop();
        if (!/^[a-f0-9]{12}$/.test(prefix)) throw new HttpError(422, "validation_error", "令牌 ID 无效");
        db.prepare("DELETE FROM api_tokens WHERE user_id = ? AND substr(token_hash, 1, 12) = ?").run(current.user.id, prefix);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (method === "GET" && pathname === "/api/admin/users") {
        requireAdmin(request);
        sendJson(response, 200, { users: service.listUsers() });
        return;
      }

      if (method === "POST" && pathname === "/api/admin/users") {
        const current = requireAdmin(request);
        authRateLimiter(request, "admin-create-user");
        const body = await readJson(request);
        const user = service.createUser({
          username: body.username,
          displayName: body.displayName,
          password: body.password,
          role: body.role,
          initialCredits: body.initialCredits
        }, current.user.id);
        sendJson(response, 201, { user });
        return;
      }

      const adminPasswordMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/password$/);
      if (method === "POST" && adminPasswordMatch) {
        const current = requireAdmin(request);
        authRateLimiter(request, "admin-reset-password");
        const body = await readJson(request);
        const result = service.resetPassword(adminPasswordMatch[1], body.newPassword);
        if (result.userId === current.user.id) {
          response.setHeader("set-cookie", clearSessionCookie(config.secureCookies));
        }
        sendJson(response, 200, { ...result, reauthRequired: result.userId === current.user.id });
        return;
      }

      if (method === "POST" && pathname === "/api/admin/credits") {
        const current = requireAdmin(request);
        const body = await readJson(request);
        const userId = String(body.userId || "");
        const wallet = service.addCredits(userId, body.amount, body.reason, current.user.id);
        sendJson(response, 200, { wallet });
        return;
      }

      if (method === "GET" && pathname === "/api/admin/provider-settings") {
        requireAdmin(request);
        sendJson(response, 200, { settings: service.providerSettings() });
        return;
      }

      if (method === "POST" && pathname === "/api/admin/provider-settings/test") {
        requireAdmin(request);
        const body = await readJson(request);
        const result = await service.testProviderSettings(body);
        sendJson(response, 200, { result });
        return;
      }

      if (method === "POST" && pathname === "/api/admin/provider-settings") {
        const current = requireAdmin(request);
        const body = await readJson(request);
        const settings = service.updateProviderSettings(body, current.user.id);
        sendJson(response, 200, { settings, providerStatus: service.providerStatus() });
        return;
      }

      if (pathname.startsWith("/api/")) throw new HttpError(404, "not_found", "接口不存在");

      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const staticPath = path.resolve(config.publicDir, relative);
      if (!staticPath.startsWith(`${path.resolve(config.publicDir)}${path.sep}`)) {
        throw new HttpError(403, "forbidden", "禁止访问");
      }
      if (method === "GET" && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
        streamFile(response, staticPath, MIME_TYPES.get(path.extname(staticPath).toLowerCase()) || "application/octet-stream");
        return;
      }

      throw new HttpError(404, "not_found", "页面不存在");
    } catch (error) {
      sendError(response, error);
    }
  });

  return {
    config,
    db,
    service,
    server,
    async listen(port = config.port, host = config.host) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async close() {
      service.stop();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    }
  };
}
