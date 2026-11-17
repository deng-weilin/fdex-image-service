import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServerApplication } from "../src/server.js";

function cookieFrom(response) {
  return response.headers.get("set-cookie")?.split(";")[0];
}

test("administrators can provision accounts and credential changes revoke old access", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fdex-accounts-"));
  const application = createServerApplication({
    dataDir,
    seedDemoAccounts: true,
    demoPassword: "workshop123",
    adminPassword: "admin-password-123",
    initialCredits: 15,
    authRateLimitMax: 1000,
    providerMode: "mock",
    envFile: path.join(dataDir, "missing.env")
  });
  const address = await application.listen(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await application.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function request(pathname, { method = "GET", body, cookie, token } = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = await response.json();
    return { response, payload };
  }

  async function login(username, password) {
    const result = await request("/api/auth/login", { method: "POST", body: { username, password } });
    assert.equal(result.response.status, 200);
    return { ...result, cookie: cookieFrom(result.response) };
  }

  const admin = await login("instructor", "admin-password-123");
  const memberSeed = await login("student_a", "workshop123");
  const forbidden = await request("/api/admin/users", {
    method: "POST",
    cookie: memberSeed.cookie,
    body: { username: "forbidden_user", password: "password123" }
  });
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.payload.error, "admin_required");

  const created = await request("/api/admin/users", {
    method: "POST",
    cookie: admin.cookie,
    body: {
      username: "delivery_member",
      displayName: "交付成员",
      password: "member-pass-123",
      role: "member",
      initialCredits: 27
    }
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.user.username, "delivery_member");
  assert.equal(created.payload.user.wallet.available, 27);
  assert.equal("password_hash" in created.payload.user, false);

  const duplicate = await request("/api/admin/users", {
    method: "POST",
    cookie: admin.cookie,
    body: { username: "delivery_member", password: "another-pass-123" }
  });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.payload.error, "username_exists");

  const invalidCredits = await request("/api/admin/users", {
    method: "POST",
    cookie: admin.cookie,
    body: { username: "bad_credits", password: "password123", initialCredits: -1 }
  });
  assert.equal(invalidCredits.response.status, 422);

  const member = await login("delivery_member", "member-pass-123");
  const tokenResponse = await request("/api/tokens", {
    method: "POST",
    cookie: member.cookie,
    body: { name: "交付测试令牌" }
  });
  assert.equal(tokenResponse.response.status, 201);

  const wrongCurrent = await request("/api/account/password", {
    method: "POST",
    cookie: member.cookie,
    body: { currentPassword: "wrong-password", newPassword: "member-pass-456" }
  });
  assert.equal(wrongCurrent.response.status, 401);

  const changed = await request("/api/account/password", {
    method: "POST",
    cookie: member.cookie,
    body: { currentPassword: "member-pass-123", newPassword: "member-pass-456" }
  });
  assert.equal(changed.response.status, 200);
  assert.equal(changed.payload.reauthRequired, true);
  assert.match(changed.response.headers.get("set-cookie"), /Max-Age=0/);

  assert.equal((await request("/api/me", { cookie: member.cookie })).response.status, 401);
  assert.equal((await request("/api/me", { token: tokenResponse.payload.token })).response.status, 401);
  assert.equal((await request("/api/auth/login", {
    method: "POST",
    body: { username: "delivery_member", password: "member-pass-123" }
  })).response.status, 401);

  const relogged = await login("delivery_member", "member-pass-456");
  const reset = await request(`/api/admin/users/${created.payload.user.id}/password`, {
    method: "POST",
    cookie: admin.cookie,
    body: { newPassword: "member-pass-789" }
  });
  assert.equal(reset.response.status, 200);
  assert.equal(reset.payload.reauthRequired, false);
  assert.equal((await request("/api/me", { cookie: relogged.cookie })).response.status, 401);
  assert.equal((await request("/api/admin/users", { cookie: admin.cookie })).response.status, 200);

  assert.equal((await request("/api/auth/login", {
    method: "POST",
    body: { username: "delivery_member", password: "member-pass-456" }
  })).response.status, 401);
  await login("delivery_member", "member-pass-789");
});
