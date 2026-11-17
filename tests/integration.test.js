import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test, { after, before } from "node:test";
import { createServerApplication } from "../src/server.js";

const testDataDir = path.resolve("runtime", `test-${process.pid}-${Date.now()}`);
let application;
let baseUrl;

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
  const payload = response.headers.get("content-type")?.includes("application/json")
    ? await response.json()
    : await response.text();
  return { response, payload };
}

function cookieFrom(response) {
  return response.headers.get("set-cookie")?.split(";")[0];
}

async function login(username) {
  const { response, payload } = await request("/api/auth/login", {
    method: "POST",
    body: { username, password: "workshop123" }
  });
  assert.equal(response.status, 200);
  return { cookie: cookieFrom(response), user: payload.user };
}

async function createSpec(cookie, productName = "挡车器") {
  const { response, payload } = await request("/api/drawing-specs", {
    method: "POST",
    cookie,
    body: {
      productName,
      dimensions: [
        { name: "length", value: 530, unit: "mm", sourceRef: "D01" },
        { name: "width", value: 140, unit: "mm", sourceRef: "D01" },
        { name: "height", value: 80, unit: "mm", sourceRef: "D01" }
      ],
      material: "丁苯橡胶与黄色警示条",
      mounting: "M10 膨胀螺栓，每件两颗",
      labels: ["橡胶主体", "反光警示条", "M10 膨胀螺栓"],
      unknowns: ["安装位置 1000 mm 是否适用"],
      layout: "横向中文说明书",
      rawInput: "按资料生成说明图",
      sourceNote: "测试输入，人工整理"
    }
  });
  assert.equal(response.status, 201);
  return payload.spec;
}

async function createGenerateJob(cookie, specId, key, instruction = "生成产品说明图") {
  return request("/api/image-jobs", {
    method: "POST",
    cookie,
    body: { operation: "generate", specId, instruction, idempotencyKey: key }
  });
}

async function waitForJob(cookie, jobId, terminal = ["succeeded", "failed", "reconciling"]) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const { response, payload } = await request(`/api/image-jobs/${jobId}`, { cookie });
    assert.equal(response.status, 200);
    if (terminal.includes(payload.job.status)) return payload.job;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`job ${jobId} did not settle`);
}

async function callMcp(token, requests) {
  const child = spawn(process.execPath, [path.resolve("mcp/server.js")], {
    env: {
      ...process.env,
      IMAGE_SERVICE_URL: baseUrl,
      IMAGE_SERVICE_TOKEN: token
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let buffer = "";
  const messages = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });

  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  const expectedIds = new Set(requests.map((request) => request.id));
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && [...expectedIds].some((id) => !messages.some((message) => message.id === id))) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  for (const id of expectedIds) assert.ok(messages.some((message) => message.id === id), `MCP response ${id} missing`);
  return messages;
}

before(async () => {
  application = createServerApplication({
    dataDir: testDataDir,
    seedDemoAccounts: true,
    demoPassword: "workshop123",
    initialCredits: 14,
    authRateLimitMax: 1000,
    providerMode: "mock",
    queueDelayMs: 80,
    duplicateSubmitWindowMs: 3000,
    envFile: path.join(testDataDir, "missing.env")
  });
  const address = await application.listen(0, "127.0.0.1");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (application) await application.close();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test("full generate/edit loop settles credits and preserves version parent", async () => {
  const { cookie } = await login("student_a");
  const spec = await createSpec(cookie);
  const first = await createGenerateJob(cookie, spec.id, "test-generate-key-0001");
  assert.equal(first.response.status, 201);

  const duplicate = await createGenerateJob(cookie, spec.id, "test-generate-key-0001");
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.payload.duplicate, true);
  assert.equal(duplicate.payload.job.id, first.payload.job.id);

  const conflict = await createGenerateJob(cookie, spec.id, "test-generate-key-0001", "不同内容");
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.payload.error, "idempotency_conflict");

  const generated = await waitForJob(cookie, first.payload.job.id);
  assert.equal(generated.status, "succeeded");
  assert.equal(generated.image.versionNumber, 1);
  assert.equal(generated.image.parentImageId, null);

  const editResult = await request("/api/image-jobs", {
    method: "POST",
    cookie,
    body: {
      operation: "edit",
      parentImageId: generated.image.id,
      instruction: "把警示条改为橙色",
      preserveInstructions: "保留轮廓、尺寸和其他文字",
      idempotencyKey: "test-edit-key-0001"
    }
  });
  assert.equal(editResult.response.status, 201);
  const edited = await waitForJob(cookie, editResult.payload.job.id);
  assert.equal(edited.status, "succeeded");
  assert.equal(edited.image.versionNumber, 2);
  assert.equal(edited.image.parentImageId, generated.image.id);

  const versions = await request(`/api/images/${edited.image.id}/versions`, { cookie });
  assert.deepEqual(versions.payload.versions.map((image) => image.versionNumber), [1, 2]);

  const wallet = await request("/api/wallet", { cookie });
  assert.deepEqual(
    { available: wallet.payload.available, reserved: wallet.payload.reserved, spent: wallet.payload.spent },
    { available: 0, reserved: 0, spent: 14 }
  );
  const content = await request(generated.image.contentUrl, { cookie });
  assert.equal(content.response.status, 200);
  assert.match(content.response.headers.get("content-type"), /image\/svg\+xml/);
  assert.match(content.payload, /<svg/);
  assert.match(content.payload, /挡车器/);

  const attempts = application.db.prepare("SELECT COUNT(*) AS count FROM provider_attempts").get();
  assert.equal(attempts.count, 2, "duplicate submission must not call provider twice");
});

test("asset permission and paid operation are isolated across users", async () => {
  const userA = await login("student_a");
  const userB = await login("student_b");
  const imagesA = await request("/api/images", { cookie: userA.cookie });
  const imageA = imagesA.payload.images[0];

  const readAsB = await request(imageA.contentUrl, { cookie: userB.cookie });
  assert.equal(readAsB.response.status, 404);

  const editAsB = await request("/api/image-jobs", {
    method: "POST",
    cookie: userB.cookie,
    body: {
      operation: "edit",
      parentImageId: imageA.id,
      instruction: "尝试跨用户编辑",
      idempotencyKey: "cross-user-edit-key"
    }
  });
  assert.equal(editAsB.response.status, 404);
  assert.equal(editAsB.payload.error, "parent_image_not_found");

  const walletB = await request("/api/wallet", { cookie: userB.cookie });
  assert.equal(walletB.payload.available, 14, "rejected cross-user edit must not reserve credits");
});

test("definite failure releases credits while uncertain outcome remains reconciling", async () => {
  const { cookie } = await login("student_b");
  const spec = await createSpec(cookie, "测试产品");

  const definite = await createGenerateJob(cookie, spec.id, "definite-failure-key", "FORCE_DEFINITE_FAILURE");
  const failed = await waitForJob(cookie, definite.payload.job.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "mock_definite_failure");
  const afterFailure = await request("/api/wallet", { cookie });
  assert.deepEqual(
    { available: afterFailure.payload.available, reserved: afterFailure.payload.reserved, spent: afterFailure.payload.spent },
    { available: 14, reserved: 0, spent: 0 }
  );

  const uncertain = await createGenerateJob(cookie, spec.id, "uncertain-outcome-key", "FORCE_UNCERTAIN_OUTCOME");
  const reconciling = await waitForJob(cookie, uncertain.payload.job.id);
  assert.equal(reconciling.status, "reconciling");
  assert.equal(reconciling.errorCode, "mock_uncertain_timeout");
  const afterUnknown = await request("/api/wallet", { cookie });
  assert.deepEqual(
    { available: afterUnknown.payload.available, reserved: afterUnknown.payload.reserved, spent: afterUnknown.payload.spent },
    { available: 4, reserved: 10, spent: 0 }
  );
});

test("concurrent paid requests cannot overdraw wallet and insufficient balance never calls provider", async () => {
  const register = await request("/api/auth/register", {
    method: "POST",
    body: { username: "concurrent_user", displayName: "并发测试", password: "password123" }
  });
  assert.equal(register.response.status, 201);
  const cookie = cookieFrom(register.response);
  const spec = await createSpec(cookie, "并发产品");
  const beforeAttempts = application.db.prepare("SELECT COUNT(*) AS count FROM provider_attempts").get().count;

  const [first, second] = await Promise.all([
    createGenerateJob(cookie, spec.id, "concurrent-key-one", "并发请求一"),
    createGenerateJob(cookie, spec.id, "concurrent-key-two", "并发请求二")
  ]);
  const statuses = [first.response.status, second.response.status].sort();
  assert.deepEqual(statuses, [201, 402]);
  const accepted = first.response.status === 201 ? first : second;
  const rejected = first.response.status === 402 ? first : second;
  assert.equal(rejected.payload.error, "insufficient_credits");
  assert.equal(rejected.payload.details.providerCalled, false);
  await waitForJob(cookie, accepted.payload.job.id);

  const wallet = await request("/api/wallet", { cookie });
  assert.deepEqual(
    { available: wallet.payload.available, reserved: wallet.payload.reserved, spent: wallet.payload.spent },
    { available: 4, reserved: 0, spent: 10 }
  );
  const afterAttempts = application.db.prepare("SELECT COUNT(*) AS count FROM provider_attempts").get().count;
  assert.equal(afterAttempts - beforeAttempts, 1, "rejected insufficient request must not call provider");
});

test("two fast clicks with different idempotency keys are merged before provider execution", async () => {
  const register = await request("/api/auth/register", {
    method: "POST",
    body: { username: "double_click_user", displayName: "双击测试", password: "password123" }
  });
  assert.equal(register.response.status, 201);
  const cookie = cookieFrom(register.response);
  const spec = await createSpec(cookie, "双击测试产品");

  const [first, second] = await Promise.all([
    createGenerateJob(cookie, spec.id, "double-click-key-one", "生成同一张说明图"),
    createGenerateJob(cookie, spec.id, "double-click-key-two", "生成同一张说明图")
  ]);
  assert.deepEqual([first.response.status, second.response.status].sort(), [200, 201]);
  assert.equal(first.payload.job.id, second.payload.job.id);
  const duplicate = first.payload.duplicate ? first : second;
  assert.equal(duplicate.payload.duplicate, true);
  assert.equal(duplicate.payload.dedupe, "recent_identical_request");

  await waitForJob(cookie, first.payload.job.id);
  const wallet = await request("/api/wallet", { cookie });
  assert.deepEqual(
    { available: wallet.payload.available, reserved: wallet.payload.reserved, spent: wallet.payload.spent },
    { available: 4, reserved: 0, spent: 10 }
  );
  const attempts = application.db.prepare("SELECT COUNT(*) AS count FROM provider_attempts WHERE job_id = ?")
    .get(first.payload.job.id).count;
  assert.equal(attempts, 1, "double click must create exactly one provider attempt");
});

test("worker refuses provider execution when its reservation is missing", async () => {
  const register = await request("/api/auth/register", {
    method: "POST",
    body: { username: "funding_guard_user", displayName: "资金预检测试", password: "password123" }
  });
  assert.equal(register.response.status, 201);
  const cookie = cookieFrom(register.response);
  const spec = await createSpec(cookie, "资金预检产品");
  const created = await createGenerateJob(cookie, spec.id, "funding-guard-key", "测试预留缺失");
  assert.equal(created.response.status, 201);

  application.db.prepare("UPDATE wallets SET available = available + 10, reserved = reserved - 10 WHERE user_id = ?")
    .run(created.payload.job.userId || application.db.prepare("SELECT user_id FROM jobs WHERE id = ?").get(created.payload.job.id).user_id);
  await application.service.tick();

  const failed = await waitForJob(cookie, created.payload.job.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "reservation_missing");
  const attempts = application.db.prepare("SELECT COUNT(*) AS count FROM provider_attempts WHERE job_id = ?")
    .get(created.payload.job.id).count;
  assert.equal(attempts, 0, "missing reservation must stop before provider execution");
});

test("API token authenticates the MCP server and exposes the same wallet", async () => {
  const { cookie } = await login("student_a");
  const tokenResponse = await request("/api/tokens", {
    method: "POST",
    cookie,
    body: { name: "integration-test" }
  });
  assert.equal(tokenResponse.response.status, 201);
  const token = tokenResponse.payload.token;
  assert.match(token, /^wb_/);

  const messages = await callMcp(token, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_balance", arguments: {} } }
  ]);

  assert.ok(messages.some((message) => message.id === 1 && message.result?.serverInfo?.name === "fdex-image-service"));
  const toolList = messages.find((message) => message.id === 2);
  assert.ok(toolList.result.tools.some((tool) => tool.name === "generate_image"));
  assert.ok(toolList.result.tools.some((tool) => tool.name === "edit_image"));
  const balance = messages.find((message) => message.id === 3);
  assert.equal(balance.result.isError, false, JSON.stringify(balance.result));
  const structured = balance.result.structuredContent;
  assert.ok(structured, JSON.stringify(balance.result));
  assert.equal(structured.wallet.available, 0);
  assert.equal(structured.pricing.generate, 10);
  assert.equal(structured.pricing.edit, 4);
});

test("MCP treats a succeeded SVG job as success and returns a browser URL instead of an invalid image block", async () => {
  const register = await request("/api/auth/register", {
    method: "POST",
    body: { username: "mcp_svg_user", displayName: "MCP SVG 测试", password: "password123" }
  });
  assert.equal(register.response.status, 201);
  const cookie = cookieFrom(register.response);
  const spec = await createSpec(cookie, "MCP SVG 产品");
  const created = await createGenerateJob(cookie, spec.id, "mcp-svg-job-key");
  const completed = await waitForJob(cookie, created.payload.job.id);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.image.mimeType, "image/svg+xml");

  const tokenResponse = await request("/api/tokens", {
    method: "POST",
    cookie,
    body: { name: "mcp-svg-test" }
  });
  assert.equal(tokenResponse.response.status, 201);
  const messages = await callMcp(tokenResponse.payload.token, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_image_job", arguments: { job_id: completed.id, wait_ms: 0 } }
    }
  ]);

  const result = messages.find((message) => message.id === 2).result;
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.structuredContent.status, "succeeded");
  assert.equal(result.structuredContent.image.id, completed.image.id);
  assert.equal(result.content.filter((item) => item.type === "image").length, 0);
  const fallback = result.content.find((item) => item.type === "text" && item.text.includes("image/svg+xml"));
  assert.ok(fallback, JSON.stringify(result));
  assert.match(fallback.text, /contentUrl|http:\/\/127\.0\.0\.1/);
});

test("admin can configure a live provider without exposing the API key", async () => {
  const member = await login("student_b");
  const forbidden = await request("/api/admin/provider-settings", { cookie: member.cookie });
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.payload.error, "admin_required");

  const admin = await login("instructor");
  const initial = await request("/api/admin/provider-settings", { cookie: admin.cookie });
  assert.equal(initial.response.status, 200);
  assert.equal(initial.payload.settings.providerMode, "mock");

  const secret = "test-provider-secret-1234";
  const settingsBody = {
    providerMode: "live",
    imageApiStyle: "dashscope",
    imageApiBaseUrl: "https://example.test/api/",
    imageGenerateModel: "qwen-image-test",
    imageEditModel: "qwen-image-test",
    imageApiKey: secret,
    imageSize: "1536x1024",
    imageOutputFormat: "png",
    imageNegativePrompt: "文字乱码, 低清晰度",
    imagePromptExtend: false,
    imageWatermark: false
  };
  const saved = await request("/api/admin/provider-settings", {
    method: "POST",
    cookie: admin.cookie,
    body: settingsBody
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.payload.settings.providerMode, "live");
  assert.equal(saved.payload.settings.hasApiKey, true);
  assert.equal(saved.payload.settings.apiKeyHint, "••••1234");
  assert.equal(saved.payload.settings.imageApiBaseUrl, "https://example.test/api");
  assert.equal(saved.payload.providerStatus.ready, true);
  assert.equal("imageApiKey" in saved.payload.settings, false);
  assert.equal(JSON.stringify(saved.payload).includes(secret), false);

  const health = await request("/api/health");
  assert.equal(health.payload.providerMode, "live");
  assert.equal(health.payload.providerReady, true);

  const preserved = await request("/api/admin/provider-settings", {
    method: "POST",
    cookie: admin.cookie,
    body: { ...settingsBody, imageApiKey: "", imageGenerateModel: "qwen-image-test-v2" }
  });
  assert.equal(preserved.response.status, 200);
  assert.equal(preserved.payload.settings.hasApiKey, true);
  assert.equal(JSON.stringify(preserved.payload).includes(secret), false);

  const clearedLive = await request("/api/admin/provider-settings", {
    method: "POST",
    cookie: admin.cookie,
    body: { ...settingsBody, imageApiKey: "", clearApiKey: true }
  });
  assert.equal(clearedLive.response.status, 422);
  assert.match(clearedLive.payload.message, /API Key/);

  const restored = await request("/api/admin/provider-settings", {
    method: "POST",
    cookie: admin.cookie,
    body: { ...settingsBody, providerMode: "mock", imageApiKey: "", clearApiKey: true }
  });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.payload.settings.providerMode, "mock");
  assert.equal(restored.payload.settings.hasApiKey, false);
  assert.equal(restored.payload.providerStatus.ready, true);
});

test("provider connection test accepts a full endpoint URL and returns models", async () => {
  const modelServer = http.createServer((request, response) => {
    assert.equal(request.url, "/v1/models");
    assert.equal(request.headers.authorization, "Bearer connection-test-key");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "gemini-nano-banana-2.1" }, { id: "oai-image-2.6-sunburst" }] }));
  });
  await new Promise((resolve, reject) => {
    modelServer.once("error", reject);
    modelServer.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = modelServer.address();
    const admin = await login("instructor");
    const tested = await request("/api/admin/provider-settings/test", {
      method: "POST",
      cookie: admin.cookie,
      body: {
        imageApiBaseUrl: `http://127.0.0.1:${address.port}/v1/chat/completions`,
        imageApiKey: "connection-test-key",
        imageGenerateModel: "gemini-nano-banana-2.1",
        imageEditModel: "gemini-nano-banana-2.1"
      }
    });
    assert.equal(tested.response.status, 200);
    assert.equal(tested.payload.result.baseUrl, `http://127.0.0.1:${address.port}/v1`);
    assert.deepEqual(tested.payload.result.models, ["gemini-nano-banana-2.1", "oai-image-2.6-sunburst"]);
    assert.deepEqual(tested.payload.result.missingModels, []);
  } finally {
    await new Promise((resolve) => modelServer.close(resolve));
  }
});
