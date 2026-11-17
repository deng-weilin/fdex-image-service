import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServerApplication } from "../src/server.js";

test("live mode without credentials rejects before reserving credits or creating an attempt", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fdex-provider-config-"));
  const application = createServerApplication({
    dataDir,
    demoPassword: "workshop123",
    initialCredits: 14,
    providerMode: "live",
    imageApiBaseUrl: "",
    imageApiKey: "",
    imageGenerateModel: "",
    imageEditModel: "",
    envFile: path.join(dataDir, "missing.env")
  });
  const address = await application.listen(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await application.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "student_a", password: "workshop123" })
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const specResponse = await fetch(`${baseUrl}/api/drawing-specs`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ productName: "未配置模型测试", rawInput: "生成说明图" })
  });
  const spec = (await specResponse.json()).spec;
  const jobResponse = await fetch(`${baseUrl}/api/image-jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      operation: "generate",
      specId: spec.id,
      instruction: "生成说明图",
      idempotencyKey: "provider-config-test-key"
    })
  });
  const payload = await jobResponse.json();

  assert.equal(jobResponse.status, 503);
  assert.equal(payload.error, "provider_not_configured");
  assert.equal(payload.details.providerCalled, false);
  const wallet = application.db.prepare("SELECT available, reserved FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.username = 'student_a'").get();
  assert.deepEqual({ ...wallet }, { available: 14, reserved: 0 });
  const attempts = application.db.prepare("SELECT COUNT(*) AS count FROM provider_attempts").get().count;
  assert.equal(attempts, 0);
});
