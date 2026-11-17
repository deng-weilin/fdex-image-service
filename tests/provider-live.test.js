import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DashScopeImageProvider, GenericLiveImageProvider } from "../src/provider.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("live provider sends real generation/edit requests and stores returned image bytes", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fdex-live-provider-"));
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      idempotencyKey: request.headers["idempotency-key"],
      contentType: request.headers["content-type"],
      body
    });
    response.writeHead(200, {
      "content-type": "application/json",
      "x-request-id": `req-${requests.length}`
    });
    response.end(JSON.stringify({ data: [{ b64_json: TINY_PNG.toString("base64") }] }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const address = server.address();
  const provider = new GenericLiveImageProvider({
    imageApiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    imageApiKey: "test-key",
    imageGenerateModel: "gpt-image-1",
    imageEditModel: "gpt-image-1",
    imageSize: "1536x1024",
    imageQuality: "medium",
    imageOutputFormat: "png",
    imageResponseFormat: ""
  });

  const generated = await provider.generate({
    jobId: "job-generate-001",
    prompt: "生成产品示意图",
    referenceFiles: [],
    outputPath: path.join(dataDir, "generated")
  });
  assert.equal(generated.mode, "live");
  assert.equal(generated.mimeType, "image/png");
  assert.equal(generated.providerRequestId, "req-1");
  assert.deepEqual(await fs.readFile(generated.outputPath), TINY_PNG);
  const generationBody = JSON.parse(requests[0].body.toString("utf8"));
  assert.equal(requests[0].url, "/v1/images/generations");
  assert.equal(requests[0].authorization, "Bearer test-key");
  assert.equal(requests[0].idempotencyKey, "job-generate-001");
  assert.equal(generationBody.model, "gpt-image-1");
  assert.equal(generationBody.quality, "medium");
  assert.equal(generationBody.output_format, "png");
  assert.equal("response_format" in generationBody, false);

  const parentPath = path.join(dataDir, "parent.png");
  await fs.writeFile(parentPath, TINY_PNG);
  const edited = await provider.edit({
    jobId: "job-edit-001",
    prompt: "只把警示条改为橙色",
    parentImagePath: parentPath,
    outputPath: path.join(dataDir, "edited")
  });
  assert.equal(edited.mode, "live");
  assert.equal(edited.providerRequestId, "req-2");
  assert.deepEqual(await fs.readFile(edited.outputPath), TINY_PNG);
  assert.equal(requests[1].url, "/v1/images/edits");
  assert.equal(requests[1].idempotencyKey, "job-edit-001");
  assert.match(requests[1].contentType, /^multipart\/form-data; boundary=/);
  assert.match(requests[1].body.toString("latin1"), /name="model"\r\n\r\ngpt-image-1/);
  assert.match(requests[1].body.toString("latin1"), /name="image"/);
});

test("DashScope provider sends native multimodal requests for generation and real parent edits", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fdex-dashscope-provider-"));
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(body.toString("utf8")) });
    response.writeHead(200, { "content-type": "application/json", "x-request-id": `dash-${requests.length}` });
    response.end(JSON.stringify({
      output: {
        choices: [{
          finish_reason: "stop",
          message: { role: "assistant", content: [{ image: `data:image/png;base64,${TINY_PNG.toString("base64")}` }] }
        }]
      },
      request_id: `dash-json-${requests.length}`
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const address = server.address();
  const provider = new DashScopeImageProvider({
    imageApiBaseUrl: `http://127.0.0.1:${address.port}`,
    imageApiKey: "test-key",
    imageGenerateModel: "qwen-image-2.0-pro",
    imageEditModel: "qwen-image-2.0-pro",
    imageSize: "1536x1024",
    imagePromptExtend: false,
    imageWatermark: false,
    imageNegativePrompt: "低清晰度"
  });
  const firstReference = path.join(dataDir, "reference-a.png");
  const secondReference = path.join(dataDir, "reference-b.png");
  await fs.writeFile(firstReference, TINY_PNG);
  await fs.writeFile(secondReference, TINY_PNG);

  const generated = await provider.generate({
    jobId: "dash-job-generate",
    operation: "generate",
    prompt: "生成产品说明图",
    referenceFiles: [firstReference, secondReference],
    outputPath: path.join(dataDir, "generated")
  });
  assert.equal(generated.mode, "live");
  assert.deepEqual(await fs.readFile(generated.outputPath), TINY_PNG);
  assert.equal(requests[0].url, "/api/v1/services/aigc/multimodal-generation/generation");
  assert.equal(requests[0].authorization, "Bearer test-key");
  assert.equal(requests[0].body.model, "qwen-image-2.0-pro");
  assert.equal(requests[0].body.parameters.size, "1536*1024");
  assert.equal(requests[0].body.parameters.prompt_extend, false);
  assert.equal(requests[0].body.parameters.watermark, false);
  assert.equal(requests[0].body.input.messages[0].content.filter((item) => item.image).length, 2);
  assert.match(requests[0].body.input.messages[0].content.at(-1).text, /产品说明图/);

  const parentPath = path.join(dataDir, "parent.png");
  await fs.writeFile(parentPath, TINY_PNG);
  const edited = await provider.edit({
    jobId: "dash-job-edit",
    operation: "edit",
    prompt: "只把警示条改为橙色",
    parentImagePath: parentPath,
    outputPath: path.join(dataDir, "edited")
  });
  assert.deepEqual(await fs.readFile(edited.outputPath), TINY_PNG);
  assert.equal(requests[1].body.input.messages[0].content.filter((item) => item.image).length, 1);
  assert.match(requests[1].body.input.messages[0].content[0].image, /^data:image\/png;base64,/);
  assert.match(requests[1].body.input.messages[0].content.at(-1).text, /橙色/);
});
