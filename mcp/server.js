#!/usr/bin/env node
import process from "node:process";
import crypto from "node:crypto";

const SERVICE_URL = (process.env.IMAGE_SERVICE_URL || "http://127.0.0.1:4310").replace(/\/$/, "");
const SERVICE_TOKEN = process.env.IMAGE_SERVICE_TOKEN || "";

class McpApiError extends Error {
  constructor(message, code = "api_error") {
    super(message);
    this.code = code;
  }
}

async function api(path, options = {}) {
  if (!SERVICE_TOKEN) throw new McpApiError("缺少 IMAGE_SERVICE_TOKEN", "token_not_configured");
  const response = await fetch(`${SERVICE_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      authorization: `Bearer ${SERVICE_TOKEN}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" })
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new McpApiError(payload.message || `HTTP ${response.status}`, payload.error || "api_error");
  return payload;
}

function textResult(value, structured = undefined) {
  const structuredContent = structured === undefined && value && typeof value === "object" ? value : structured;
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(structuredContent ? { structuredContent } : {}),
    isError: false
  };
}

function errorResult(error) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: error.code || "tool_error", message: error.message }, null, 2) }],
    isError: true
  };
}

async function imageJobResult(jobId, waitMs = 15000) {
  const deadline = Date.now() + Math.max(0, Math.min(waitMs, 30000));
  let job;
  do {
    ({ job } = await api(`/api/image-jobs/${encodeURIComponent(jobId)}`));
    if (job.status === "succeeded" || job.status === "failed" || job.status === "reconciling") break;
    await new Promise((resolve) => setTimeout(resolve, 750));
  } while (Date.now() < deadline);

  const summary = {
    jobId: job.id,
    operation: job.operation,
    status: job.status,
    price: job.price,
    providerMode: job.providerMode,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    image: job.image ? {
      id: job.image.id,
      versionNumber: job.image.versionNumber,
      parentImageId: job.image.parentImageId,
      contentUrl: `${SERVICE_URL}${job.image.contentUrl}`,
      downloadUrl: `${SERVICE_URL}${job.image.downloadUrl}`
    } : null,
    nextAction: job.status === "reconciling" ? "结果未知：查询同一 jobId，不要重新提交付费任务" : null
  };
  const content = [{ type: "text", text: JSON.stringify(summary, null, 2) }];
  if (job.status === "succeeded" && job.image) {
    const response = await fetch(`${SERVICE_URL}${job.image.contentUrl}`, { headers: { authorization: `Bearer ${SERVICE_TOKEN}` } });
    if (response.ok) {
      const mimeType = response.headers.get("content-type")?.split(";")[0] || job.image.mimeType;
      const rasterTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
      if (rasterTypes.includes(mimeType)) {
        const buffer = Buffer.from(await response.arrayBuffer());
        content.push({ type: "image", data: buffer.toString("base64"), mimeType });
      } else {
        content.push({
          type: "text",
          text: `图稿格式为 ${mimeType}，不能作为内嵌图片返回（客户端只接受 PNG/JPEG/WebP）。用浏览器打开预览：${summary.image.contentUrl}`
        });
      }
    }
  }
  return { content, structuredContent: summary, isError: job.status === "failed" || job.status === "reconciling" };
}

const tools = [
  {
    name: "get_balance",
    description: "读取当前 WorkBuddy 认证账户的可用、预留和累计消费 Credits，以及新生成/编辑固定价格。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "prepare_drawing_spec",
    description: "把产品或资料要求整理并保存为 DrawingSpec。会保留未知项，不把不确定尺寸补成事实。",
    inputSchema: {
      type: "object",
      properties: {
        product_name: { type: "string", minLength: 1, maxLength: 100 },
        dimensions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              value: { type: ["string", "number"] },
              unit: { type: "string", default: "mm" },
              source_ref: { type: "string" }
            },
            required: ["name", "value"]
          }
        },
        material: { type: "string" },
        mounting: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        unknowns: { type: "array", items: { type: "string" } },
        layout: { type: "string" },
        raw_input: { type: "string" },
        source_note: { type: "string" },
        input_asset_ids: { type: "array", items: { type: "string" } }
      },
      required: ["product_name"]
    }
  },
  {
    name: "list_assets",
    description: "列出当前账户可用的上传资料和参考图。将这些 ID 放入 prepare_drawing_spec 的 input_asset_ids，即可让新生成使用同一份资料。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "generate_image",
    description: "按已保存 DrawingSpec 提交一次新生成任务，服务端按新生成档固定收费。调用方必须已向用户明确费用并获得执行意图；确认后传 confirm_charge=true。外部参考图仍属于新生成。",
    inputSchema: {
      type: "object",
      properties: {
        spec_id: { type: "string" },
        instruction: { type: "string" },
        idempotency_key: { type: "string", minLength: 8 },
        confirm_charge: { type: "boolean" },
        wait_ms: { type: "number", minimum: 0, maximum: 30000, default: 15000 }
      },
      required: ["spec_id", "instruction", "confirm_charge"]
    }
  },
  {
    name: "edit_image",
    description: "基于当前用户已有图片创建调整任务，服务端验证父图并按编辑档固定收费。调用方必须明确选定父图、修改项和保留项；确认后传 confirm_charge=true。",
    inputSchema: {
      type: "object",
      properties: {
        parent_image_id: { type: "string" },
        instruction: { type: "string" },
        preserve_instructions: { type: "string" },
        idempotency_key: { type: "string", minLength: 8 },
        confirm_charge: { type: "boolean" },
        wait_ms: { type: "number", minimum: 0, maximum: 30000, default: 15000 }
      },
      required: ["parent_image_id", "instruction", "confirm_charge"]
    }
  },
  {
    name: "get_image_job",
    description: "查询已有任务。若成功，同时返回图稿预览。慢任务应继续查询同一 jobId，绝不能为同一次请求重新提交付费任务。",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" }, wait_ms: { type: "number", minimum: 0, maximum: 30000, default: 0 } },
      required: ["job_id"]
    }
  },
  {
    name: "list_images",
    description: "列出当前账户可访问的图稿版本，用于选择编辑父图。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "list_image_versions",
    description: "查看指定图稿的父链版本关系。",
    inputSchema: {
      type: "object",
      properties: { image_id: { type: "string" } },
      required: ["image_id"]
    }
  }
];

async function callTool(name, args) {
  if (name === "get_balance") {
    const [{ user, wallet, pricing, providerMode, providerReady }, transactions] = await Promise.all([
      api("/api/me"),
      api("/api/wallet/transactions?limit=8")
    ]);
    return textResult({
      user: { id: user.id, displayName: user.displayName },
      wallet,
      pricing: { generate: pricing.generate, edit: pricing.edit, unit: "credits" },
      providerMode,
      providerReady,
      recentTransactions: transactions.transactions.map((item) => ({ type: item.type, description: item.description, createdAt: item.createdAt }))
    });
  }

  if (name === "prepare_drawing_spec") {
    const payload = await api("/api/drawing-specs", {
      method: "POST",
      body: {
        productName: args.product_name,
        dimensions: (args.dimensions || []).map((item) => ({ name: item.name, value: item.value, unit: item.unit || "mm", sourceRef: item.source_ref || "用户提供" })),
        material: args.material || "",
        mounting: args.mounting || "",
        labels: args.labels || [],
        unknowns: args.unknowns || [],
        layout: args.layout || "横向、中文、白底、清晰说明书风格",
        rawInput: args.raw_input || "",
        sourceNote: args.source_note || "WorkBuddy 根据用户提供材料整理，需用户复核",
        inputAssetIds: args.input_asset_ids || []
      }
    });
    return textResult({ spec: payload.spec, note: payload.spec.unknowns?.length ? "存在待确认项；图稿会省略或标记，不会擅自补成事实。" : "需求已保存。" });
  }

  if (name === "list_assets") {
    const payload = await api("/api/assets");
    return textResult({ assets: payload.assets.map((asset) => ({ ...asset, contentUrl: `${SERVICE_URL}${asset.contentUrl}` })) });
  }

  if (name === "generate_image") {
    if (args.confirm_charge !== true) throw new McpApiError("用户尚未确认付费生成", "charge_not_confirmed");
    const result = await api("/api/image-jobs", {
      method: "POST",
      body: {
        operation: "generate",
        specId: args.spec_id,
        instruction: args.instruction,
        idempotencyKey: args.idempotency_key || `mcp-generate-${crypto.randomUUID()}`
      }
    });
    return imageJobResult(result.job.id, args.wait_ms ?? 15000);
  }

  if (name === "edit_image") {
    if (args.confirm_charge !== true) throw new McpApiError("用户尚未确认付费编辑", "charge_not_confirmed");
    const result = await api("/api/image-jobs", {
      method: "POST",
      body: {
        operation: "edit",
        parentImageId: args.parent_image_id,
        instruction: args.instruction,
        preserveInstructions: args.preserve_instructions || "保留父图结构、尺寸和其他未要求改变的内容",
        idempotencyKey: args.idempotency_key || `mcp-edit-${crypto.randomUUID()}`
      }
    });
    return imageJobResult(result.job.id, args.wait_ms ?? 15000);
  }

  if (name === "get_image_job") return imageJobResult(args.job_id, args.wait_ms || 0);

  if (name === "list_images") {
    const payload = await api("/api/images");
    return textResult({ images: payload.images.map((image) => ({ ...image, contentUrl: `${SERVICE_URL}${image.contentUrl}`, downloadUrl: `${SERVICE_URL}${image.downloadUrl}` })) });
  }

  if (name === "list_image_versions") {
    const payload = await api(`/api/images/${encodeURIComponent(args.image_id)}/versions`);
    return textResult({ versions: payload.versions.map((image) => ({ ...image, contentUrl: `${SERVICE_URL}${image.contentUrl}` })) });
  }

  throw new McpApiError(`未知工具：${name}`, "unknown_tool");
}

function response(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleMessage(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  const { id, method, params = {} } = message;
  if (id === undefined || id === null) return;
  try {
    if (method === "initialize") {
      response(id, {
        protocolVersion: params.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fdex-image-service", version: "1.0.0" },
        instructions: "所有付费操作先查询价格并获得用户明确确认。以后端返回的 jobId 查询慢任务，不自动重复提交。"
      });
      return;
    }
    if (method === "ping") {
      response(id, {});
      return;
    }
    if (method === "tools/list") {
      response(id, { tools });
      return;
    }
    if (method === "tools/call") {
      try {
        response(id, await callTool(params.name, params.arguments || {}));
      } catch (error) {
        response(id, errorResult(error));
      }
      return;
    }
    response(id, {});
  } catch (error) {
    writeMessage({ jsonrpc: "2.0", id, error: { code: -32603, message: error.message } });
  }
}

let buffer = "";
let processing = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    buffer = buffer.replace(/^\s+/, "");
    if (!buffer) break;
    let raw;
    if (/^Content-Length:/i.test(buffer)) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = buffer.slice(0, headerEnd);
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
      if (!Number.isFinite(length)) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      if (buffer.length < headerEnd + 4 + length) break;
      raw = buffer.slice(headerEnd + 4, headerEnd + 4 + length);
      buffer = buffer.slice(headerEnd + 4 + length);
    } else {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
    }
    if (!raw.trim()) continue;
    try {
      const message = JSON.parse(raw);
      processing = processing.then(() => handleMessage(message));
    } catch (error) {
      writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${error.message}` } });
    }
  }
});

process.stdin.on("end", () => processing.finally(() => process.exit(0)));
