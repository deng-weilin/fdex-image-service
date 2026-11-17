import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getConfig } from "../src/config.js";
import { createServerApplication } from "../src/server.js";

test("production mode disables demo registration and sets secure cookies", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fdex-production-"));
  const application = createServerApplication({
    dataDir,
    appEnvironment: "production",
    appOrigin: "https://images.example.test",
    allowRegistration: false,
    seedDemoAccounts: false,
    secureCookies: true,
    initialCredits: 0,
    adminPassword: "admin-password-123",
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

  const session = await fetch(`${baseUrl}/api/auth/session`);
  assert.equal(session.status, 200);
  const sessionPayload = await session.json();
  assert.deepEqual(sessionPayload.features, {
    allowRegistration: false,
    demoAccountsEnabled: false
  });

  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "public_user", displayName: "Public", password: "password123" })
  });
  assert.equal(registration.status, 403);
  assert.equal((await registration.json()).error, "registration_disabled");

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "instructor", password: "admin-password-123" })
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /; Secure/);
  assert.equal(application.db.prepare("SELECT COUNT(*) AS count FROM users WHERE username IN ('student_a', 'student_b')").get().count, 0);
});

test("production mode requires HTTPS and rejects demo account seeding", () => {
  assert.throws(
    () => getConfig({
      appEnvironment: "production",
      appOrigin: "http://images.example.test",
      seedDemoAccounts: false,
      envFile: path.join(os.tmpdir(), "missing-fdex.env")
    }),
    /https/
  );
  assert.throws(
    () => getConfig({
      appEnvironment: "production",
      appOrigin: "https://images.example.test",
      seedDemoAccounts: true,
      envFile: path.join(os.tmpdir(), "missing-fdex.env")
    }),
    /SEED_DEMO_ACCOUNTS/
  );
});

test("authentication endpoints rate limit repeated requests", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fdex-auth-limit-"));
  const application = createServerApplication({
    dataDir,
    appEnvironment: "test",
    seedDemoAccounts: true,
    demoPassword: "workshop123",
    authRateLimitMax: 2,
    authRateLimitWindowMs: 60_000,
    providerMode: "mock",
    envFile: path.join(dataDir, "missing.env")
  });
  const address = await application.listen(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await application.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "student_a", password: "wrong-password" })
    });
    assert.equal(response.status, 401);
  }
  const limited = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "student_a", password: "wrong-password" })
  });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
});
