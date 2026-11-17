import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { createProvider, ProviderDefiniteFailure, ProviderOutcomeUncertain } from "./provider.js";
import { hashPassword, sha256, stableJson, uuid, verifyPassword } from "./security.js";
import { withTransaction } from "./database.js";

export class HttpError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isoNow() {
  return new Date().toISOString();
}

function asInteger(value, name, min = 0, max = 1_000_000) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(422, "validation_error", `${name} 必须是 ${min}-${max} 的整数`);
  }
  return parsed;
}

function text(value, name, maxLength, required = false) {
  const result = String(value ?? "").trim();
  if (required && !result) throw new HttpError(422, "validation_error", `${name} 不能为空`);
  if (result.length > maxLength) throw new HttpError(422, "validation_error", `${name} 过长`);
  return result;
}

function stringArray(value, maxItems = 20, maxLength = 120) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((item) => item.slice(0, maxLength));
}

function normalizeUsername(value) {
  const username = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    throw new HttpError(422, "validation_error", "账号需为 3-32 位字母、数字或下划线");
  }
  return username;
}

function validatePassword(value, label = "密码") {
  const password = String(value ?? "");
  if (password.length < 8 || password.length > 128) {
    throw new HttpError(422, "validation_error", `${label}长度需为 8-128 位`);
  }
  return password;
}

function normalizeDimensions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((item, index) => {
    const name = text(item?.name, `dimensions[${index}].name`, 32, true).toLowerCase();
    const amount = String(item?.value ?? "").trim();
    if (!amount) throw new HttpError(422, "validation_error", `dimensions[${index}].value 不能为空`);
    const unit = text(item?.unit || "mm", `dimensions[${index}].unit`, 12, true);
    const sourceRef = text(item?.sourceRef || "用户输入", `dimensions[${index}].sourceRef`, 160);
    return { name: name.slice(0, 32), value: amount.slice(0, 32), unit: unit.slice(0, 12), sourceRef };
  });
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const PROVIDER_SETTINGS_KEY = "image_provider";

function providerConfigSnapshot(config) {
  return {
    providerMode: config.providerMode,
    imageApiBaseUrl: config.imageApiBaseUrl,
    imageApiKey: config.imageApiKey,
    imageApiStyle: config.imageApiStyle,
    imageGenerateModel: config.imageGenerateModel,
    imageEditModel: config.imageEditModel,
    imageSize: config.imageSize,
    imageOutputFormat: config.imageOutputFormat,
    imageNegativePrompt: config.imageNegativePrompt,
    imagePromptExtend: Boolean(config.imagePromptExtend),
    imageWatermark: Boolean(config.imageWatermark)
  };
}

function loadPersistedProviderConfig(db, config) {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(PROVIDER_SETTINGS_KEY);
  const saved = parseJson(row?.value, null);
  return saved && typeof saved === "object" ? { ...config, ...saved } : config;
}

function apiKeyHint(value) {
  const key = String(value || "");
  return key ? `••••${key.slice(-4)}` : "";
}

function normalizeBaseUrl(value) {
  const raw = text(value, "API 地址", 500, true)
    .replace(/\/+$/, "")
    .replace(/\/(?:chat\/completions|images\/generations|images\/edits)$/i, "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError(422, "validation_error", "API 地址必须是有效的 HTTP 或 HTTPS URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new HttpError(422, "validation_error", "API 地址仅支持不含账号信息的 HTTP 或 HTTPS URL");
  }
  return raw;
}

function validateImageSize(value) {
  const size = text(value, "图片尺寸", 32, true);
  const match = size.match(/^(\d+)\s*[x*]\s*(\d+)$/i);
  if (!match) throw new HttpError(422, "validation_error", "图片尺寸必须为“宽x高”格式");
  const pixels = Number(match[1]) * Number(match[2]);
  if (pixels < 512 * 512 || pixels > 2048 * 2048) {
    throw new HttpError(422, "validation_error", "图片尺寸需在 512x512 至 2048x2048 像素范围内");
  }
  return `${Number(match[1])}x${Number(match[2])}`;
}

function mapSpec(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    productName: row.product_name,
    rawInput: row.raw_input,
    status: row.status,
    createdAt: row.created_at,
    ...parseJson(row.spec_json, {})
  };
}

function mapAsset(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
    contentUrl: `/api/assets/${row.id}/content`
  };
}

function mapImage(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    parentImageId: row.parent_image_id,
    versionNumber: row.version_number,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    operation: row.operation || null,
    providerMode: row.provider_mode || null,
    contentUrl: `/api/images/${row.id}/content`,
    downloadUrl: `/api/images/${row.id}/content?download=1`
  };
}

function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    operation: row.operation,
    status: row.status,
    price: row.price,
    specId: row.spec_id,
    parentImageId: row.parent_image_id,
    instruction: row.instruction,
    preserveInstructions: row.preserve_instructions,
    providerMode: row.provider_mode,
    providerRequestId: row.provider_request_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    image: row.image_id ? mapImage({
      id: row.image_id,
      user_id: row.user_id,
      job_id: row.id,
      parent_image_id: row.parent_image_id,
      version_number: row.version_number,
      storage_path: row.storage_path,
      mime_type: row.image_mime_type,
      size_bytes: row.image_size_bytes,
      created_at: row.image_created_at,
      operation: row.operation,
      provider_mode: row.provider_mode
    }) : null
  };
}

function mapTransaction(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    type: row.type,
    availableDelta: row.available_delta,
    reservedDelta: row.reserved_delta,
    spentDelta: row.spent_delta,
    availableAfter: row.available_after,
    reservedAfter: row.reserved_after,
    spentAfter: row.spent_after,
    description: row.description,
    actorId: row.actor_id,
    createdAt: row.created_at
  };
}

export class ImageService {
  constructor(db, config) {
    this.db = db;
    this.config = loadPersistedProviderConfig(db, config);
    this.provider = createProvider(this.config);
    this.timer = null;
    this.activeJobs = new Set();
  }

  start() {
    this.recoverInterruptedJobs();
    this.timer = setInterval(() => this.tick().catch((error) => console.error("worker tick failed", error)), 250);
    this.timer.unref?.();
    this.tick().catch((error) => console.error("initial worker tick failed", error));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  pricing() {
    return {
      version: "workshop-v1",
      generate: this.config.generatePrice,
      edit: this.config.editPrice,
      currency: "credits",
      imagesPerJob: 1
    };
  }

  providerStatus(operation = null) {
    if (this.config.providerMode === "mock") return { mode: "mock", ready: true, missing: [] };
    const missing = [];
    if (!this.config.imageApiBaseUrl) missing.push("IMAGE_API_BASE_URL");
    if (!this.config.imageApiKey) missing.push("IMAGE_API_KEY");
    const checkGenerate = operation !== "edit";
    const checkEdit = operation !== "generate";
    if (checkGenerate && !this.config.imageGenerateModel) missing.push("IMAGE_GENERATE_MODEL");
    if (checkEdit && !this.config.imageEditModel) missing.push("IMAGE_EDIT_MODEL");
    return { mode: "live", ready: missing.length === 0, missing };
  }

  assertProviderReady(operation) {
    const status = this.providerStatus(operation);
    if (status.ready) return;
    throw new HttpError(503, "provider_not_configured", `真实图像服务未配置：${status.missing.join("、")}`, {
      missing: status.missing,
      providerCalled: false
    });
  }

  providerSettings() {
    const row = this.db.prepare("SELECT updated_at, updated_by FROM app_settings WHERE key = ?").get(PROVIDER_SETTINGS_KEY);
    return {
      providerMode: this.config.providerMode,
      imageApiBaseUrl: this.config.imageApiBaseUrl,
      imageApiStyle: this.config.imageApiStyle,
      imageGenerateModel: this.config.imageGenerateModel,
      imageEditModel: this.config.imageEditModel,
      imageSize: this.config.imageSize,
      imageOutputFormat: this.config.imageOutputFormat,
      imageNegativePrompt: this.config.imageNegativePrompt,
      imagePromptExtend: Boolean(this.config.imagePromptExtend),
      imageWatermark: Boolean(this.config.imageWatermark),
      hasApiKey: Boolean(this.config.imageApiKey),
      apiKeyHint: apiKeyHint(this.config.imageApiKey),
      source: row ? "database" : "environment",
      updatedAt: row?.updated_at || null,
      updatedBy: row?.updated_by || null
    };
  }

  updateProviderSettings(input, actorId) {
    const providerMode = String(input.providerMode || "").toLowerCase() === "live" ? "live" : "mock";
    let imageApiStyle = text(input.imageApiStyle || "openai", "接口类型", 32, true).toLowerCase();
    if (["aliyun", "qwen"].includes(imageApiStyle)) imageApiStyle = "dashscope";
    if (["openai-chat", "openai_chat", "chat-completions"].includes(imageApiStyle)) imageApiStyle = "chat";
    if (!["openai", "dashscope", "chat"].includes(imageApiStyle)) {
      throw new HttpError(422, "validation_error", "接口类型仅支持 openai、dashscope 或 chat");
    }
    const imageApiBaseUrl = text(input.imageApiBaseUrl || "", "API 地址", 500);
    const imageGenerateModel = text(input.imageGenerateModel || "", "生成模型", 160);
    const imageEditModel = text(input.imageEditModel || "", "编辑模型", 160);
    const suppliedApiKey = text(input.imageApiKey || "", "API Key", 2000);
    const imageApiKey = input.clearApiKey ? "" : suppliedApiKey || this.config.imageApiKey || "";
    const imageSize = validateImageSize(input.imageSize || "1536x1024");
    const imageOutputFormat = text(input.imageOutputFormat || "png", "输出格式", 20, true).toLowerCase();
    if (!["png", "jpeg", "jpg", "webp"].includes(imageOutputFormat)) {
      throw new HttpError(422, "validation_error", "输出格式仅支持 png、jpeg、jpg 或 webp");
    }
    const imageNegativePrompt = text(input.imageNegativePrompt || "", "反向提示词", 2000);
    if (providerMode === "live") {
      const missing = [];
      if (!imageApiBaseUrl) missing.push("API 地址");
      if (!imageApiKey) missing.push("API Key");
      if (!imageGenerateModel) missing.push("生成模型");
      if (!imageEditModel) missing.push("编辑模型");
      if (missing.length) {
        throw new HttpError(422, "validation_error", `启用真实服务前必须配置：${missing.join("、")}`);
      }
    }
    const normalizedBaseUrl = imageApiBaseUrl ? normalizeBaseUrl(imageApiBaseUrl) : "";
    const next = {
      ...providerConfigSnapshot(this.config),
      providerMode,
      imageApiStyle,
      imageApiBaseUrl: normalizedBaseUrl,
      imageGenerateModel,
      imageEditModel,
      imageApiKey,
      imageSize,
      imageOutputFormat,
      imageNegativePrompt,
      imagePromptExtend: Boolean(input.imagePromptExtend),
      imageWatermark: Boolean(input.imageWatermark)
    };
    const now = isoNow();
    this.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
    `).run(PROVIDER_SETTINGS_KEY, JSON.stringify(next), now, actorId);
    this.config = { ...this.config, ...next };
    this.provider = createProvider(this.config);
    return this.providerSettings();
  }

  async testProviderSettings(input) {
    const imageApiBaseUrl = normalizeBaseUrl(input.imageApiBaseUrl || this.config.imageApiBaseUrl);
    const suppliedApiKey = text(input.imageApiKey || "", "API Key", 2000);
    const imageApiKey = suppliedApiKey || this.config.imageApiKey || "";
    if (!imageApiKey) throw new HttpError(422, "validation_error", "连接测试前必须填写 API Key");
    let response;
    try {
      response = await fetch(`${imageApiBaseUrl}/models`, {
        headers: { authorization: `Bearer ${imageApiKey}` },
        signal: AbortSignal.timeout(20_000)
      });
    } catch (error) {
      throw new HttpError(502, "provider_unreachable", `无法连接图像服务：${error.message}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new HttpError(502, "provider_test_failed", `连接测试失败：HTTP ${response.status} ${body.slice(0, 240)}`);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new HttpError(502, "provider_test_failed", "服务返回的模型列表不是有效 JSON");
    }
    const models = Array.isArray(payload?.data)
      ? payload.data.map((item) => String(item?.id || "").trim()).filter(Boolean)
      : [];
    if (!models.length) throw new HttpError(502, "provider_test_failed", "连接成功，但没有返回可用模型");
    const requestedModels = [input.imageGenerateModel, input.imageEditModel].map((item) => String(item || "").trim()).filter(Boolean);
    return {
      ok: true,
      baseUrl: imageApiBaseUrl,
      models,
      missingModels: requestedModels.filter((model) => !models.includes(model)),
      requestId: response.headers.get("x-request-id") || response.headers.get("request-id") || null
    };
  }

  wallet(userId) {
    const row = this.db.prepare("SELECT available, reserved, spent, updated_at FROM wallets WHERE user_id = ?").get(userId);
    if (!row) throw new HttpError(404, "wallet_not_found", "钱包不存在");
    return {
      available: row.available,
      reserved: row.reserved,
      spent: row.spent,
      updatedAt: row.updated_at
    };
  }

  transactions(userId, limit = 100) {
    return this.db
      .prepare("SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(userId, Math.min(asInteger(limit, "limit", 1, 500), 500))
      .map(mapTransaction);
  }

  addCredits(userId, amount, reason, actorId) {
    const creditAmount = asInteger(amount, "amount", 1, 100_000);
    const description = text(reason, "reason", 240, true);
    return withTransaction(this.db, () => {
      const wallet = this.db.prepare("SELECT * FROM wallets WHERE user_id = ?").get(userId);
      if (!wallet) throw new HttpError(404, "user_not_found", "用户不存在");
      const now = isoNow();
      const nextAvailable = wallet.available + creditAmount;
      this.db.prepare("UPDATE wallets SET available = ?, updated_at = ? WHERE user_id = ?")
        .run(nextAvailable, now, userId);
      const transactionId = uuid();
      this.db.prepare(`
        INSERT INTO transactions (
          id, user_id, job_id, type, available_delta, reserved_delta, spent_delta,
          available_after, reserved_after, spent_after, description, actor_id, created_at
        ) VALUES (?, ?, NULL, 'compensation', ?, 0, 0, ?, ?, ?, ?, ?, ?)
      `).run(
        transactionId, userId, creditAmount, nextAvailable, wallet.reserved, wallet.spent,
        description, actorId, now
      );
      return this.wallet(userId);
    });
  }

  createAsset(userId, input) {
    const originalName = text(input.name, "文件名", 180, true);
    const mimeType = text(input.mimeType, "文件类型", 80, true).toLowerCase();
    const allowed = new Map([
      ["image/jpeg", ".jpg"],
      ["image/png", ".png"],
      ["image/webp", ".webp"]
    ]);
    if (!allowed.has(mimeType)) throw new HttpError(415, "unsupported_media", "仅支持 JPG、PNG 或 WebP");
    if (typeof input.dataBase64 !== "string" || input.dataBase64.length < 8) {
      throw new HttpError(422, "validation_error", "文件内容不能为空");
    }
    const buffer = Buffer.from(input.dataBase64.replace(/^data:[^;]+;base64,/, ""), "base64");
    if (!buffer.length) throw new HttpError(422, "validation_error", "文件内容无法读取");
    if (buffer.length > 8 * 1024 * 1024) throw new HttpError(413, "file_too_large", "单个文件不能超过 8 MB");
    const id = uuid();
    const storagePath = path.join(this.config.uploadsDir, `${id}${allowed.get(mimeType)}`);
    fs.writeFileSync(storagePath, buffer);
    const kind = text(input.kind || "reference", "资料类型", 32) || "reference";
    const now = isoNow();
    this.db.prepare(`
      INSERT INTO assets (
        id, user_id, kind, original_name, mime_type, size_bytes, storage_path, sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, kind, originalName, mimeType, buffer.length, storagePath, sha256(buffer), now);
    return mapAsset(this.db.prepare("SELECT * FROM assets WHERE id = ?").get(id));
  }

  loadSampleAssets(userId) {
    const samples = [
      ["source-product.png", "product_source", "image/png", "产品外观示例"],
      ["reference-detail.png", "style_reference", "image/png", "安装说明图示例"]
    ];
    const result = [];
    for (const [fileName, kind, mimeType, displayName] of samples) {
      const existing = this.db.prepare("SELECT * FROM assets WHERE user_id = ? AND original_name = ? ORDER BY created_at DESC LIMIT 1")
        .get(userId, displayName);
      if (existing) {
        result.push(mapAsset(existing));
        continue;
      }
      const sourcePath = path.join(this.config.publicDir, "samples", fileName);
      if (!fs.existsSync(sourcePath)) continue;
      const buffer = fs.readFileSync(sourcePath);
      const id = uuid();
      const storagePath = path.join(this.config.uploadsDir, `${id}${path.extname(fileName)}`);
      fs.writeFileSync(storagePath, buffer);
      const now = isoNow();
      this.db.prepare(`
        INSERT INTO assets (
          id, user_id, kind, original_name, mime_type, size_bytes, storage_path, sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, userId, kind, displayName, mimeType, buffer.length, storagePath, sha256(buffer), now);
      result.push(mapAsset(this.db.prepare("SELECT * FROM assets WHERE id = ?").get(id)));
    }
    return result;
  }

  listAssets(userId) {
    return this.db.prepare("SELECT * FROM assets WHERE user_id = ? ORDER BY created_at DESC").all(userId).map(mapAsset);
  }

  getAsset(userId, assetId) {
    const row = this.db.prepare("SELECT * FROM assets WHERE id = ? AND user_id = ?").get(assetId, userId);
    if (!row) throw new HttpError(404, "asset_not_found", "资料不存在");
    if (!fs.existsSync(row.storage_path)) throw new HttpError(410, "asset_file_missing", "资料文件已丢失");
    return row;
  }

  createSpec(userId, input) {
    const productName = text(input.productName, "产品名称", 100, true);
    const dimensions = normalizeDimensions(input.dimensions);
    const material = text(input.material, "材质", 500);
    const mounting = text(input.mounting, "安装方式", 500);
    const labels = stringArray(input.labels);
    const unknowns = stringArray(input.unknowns);
    const layout = text(input.layout || "横向、中文、白底、说明书风格", "版式", 300, true);
    const rawInput = text(input.rawInput || "", "资料与需求", 4000);
    const sourceNote = text(input.sourceNote || "用户填写或课堂预设资料", "来源说明", 300, true);
    const inputAssetIds = stringArray(input.inputAssetIds, 12, 80);
    for (const assetId of inputAssetIds) this.getAsset(userId, assetId);
    const specData = {
      productName,
      dimensions,
      material,
      mounting,
      labels,
      unknowns,
      unknownPolicy: text(input.unknownPolicy || "未确认项省略并在输出中标记待确认", "未知项规则", 300),
      layout,
      inputAssetIds,
      sourceNote,
      reviewStatus: unknowns.length ? "needs_user_confirmation" : "ready"
    };
    const previous = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM drawing_specs WHERE user_id = ?").get(userId);
    const id = uuid();
    const createdAt = isoNow();
    this.db.prepare(`
      INSERT INTO drawing_specs (id, user_id, version, product_name, raw_input, spec_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, previous.version + 1, productName, rawInput, JSON.stringify(specData), specData.reviewStatus, createdAt);
    return mapSpec(this.db.prepare("SELECT * FROM drawing_specs WHERE id = ?").get(id));
  }

  listSpecs(userId) {
    return this.db.prepare("SELECT * FROM drawing_specs WHERE user_id = ? ORDER BY created_at DESC").all(userId).map(mapSpec);
  }

  getSpec(userId, specId) {
    const row = this.db.prepare("SELECT * FROM drawing_specs WHERE id = ? AND user_id = ?").get(specId, userId);
    if (!row) throw new HttpError(404, "spec_not_found", "绘图需求不存在");
    return mapSpec(row);
  }

  createJob(userId, input) {
    const operation = input.operation === "edit" ? "edit" : input.operation === "generate" ? "generate" : null;
    if (!operation) throw new HttpError(422, "validation_error", "operation 必须为 generate 或 edit");
    this.assertProviderReady(operation);
    const idempotencyKey = text(input.idempotencyKey, "幂等键", 120, true);
    if (idempotencyKey.length < 8) throw new HttpError(422, "validation_error", "幂等键至少 8 个字符");
    const instruction = text(input.instruction, "绘图指令", 4000, true);
    const preserveInstructions = text(input.preserveInstructions || "", "保留项", 1000);
    const parentImageId = text(input.parentImageId || "", "父图 ID", 80);
    const specId = text(input.specId || "", "需求 ID", 80);
    if (operation === "edit") {
      if (!parentImageId) throw new HttpError(422, "parent_required", "编辑必须选择已有图片作为父图");
      const parent = this.db.prepare("SELECT * FROM images WHERE id = ? AND user_id = ?").get(parentImageId, userId);
      if (!parent) throw new HttpError(404, "parent_image_not_found", "父图不存在或无权访问");
    } else {
      if (parentImageId) throw new HttpError(422, "parent_not_allowed", "新生成不能指定父图；外部参考图请放入 DrawingSpec");
      if (!specId) throw new HttpError(422, "spec_required", "新生成必须关联已保存的绘图需求");
      this.getSpec(userId, specId);
    }
    if (specId) this.getSpec(userId, specId);
    const price = operation === "generate" ? this.config.generatePrice : this.config.editPrice;
    const requestHash = sha256(stableJson({ operation, specId, parentImageId, instruction, preserveInstructions }));
    const now = isoNow();
    const duplicateCutoff = new Date(Date.now() - Math.max(0, this.config.duplicateSubmitWindowMs || 0)).toISOString();
    let created = false;
    let jobId;
    const result = withTransaction(this.db, () => {
      const existing = this.db.prepare("SELECT * FROM jobs WHERE user_id = ? AND idempotency_key = ?").get(userId, idempotencyKey);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new HttpError(409, "idempotency_conflict", "该幂等键已用于不同内容，请使用新的幂等键");
        }
        jobId = existing.id;
        return { job: this.getJob(userId, existing.id), duplicate: true, dedupe: "idempotency_key" };
      }
      const recent = this.db.prepare(`
        SELECT * FROM jobs
        WHERE user_id = ? AND request_hash = ? AND created_at >= ?
          AND status IN ('queued', 'running', 'succeeded', 'reconciling')
        ORDER BY created_at DESC LIMIT 1
      `).get(userId, requestHash, duplicateCutoff);
      if (recent) {
        jobId = recent.id;
        return { job: this.getJob(userId, recent.id), duplicate: true, dedupe: "recent_identical_request" };
      }
      const wallet = this.db.prepare("SELECT * FROM wallets WHERE user_id = ?").get(userId);
      if (!wallet) throw new HttpError(404, "wallet_not_found", "钱包不存在");
      if (wallet.available < price) {
        throw new HttpError(402, "insufficient_credits", "Credits 不足，本次操作未调用 Image Provider", {
          required: price,
          available: wallet.available,
          providerCalled: false
        });
      }
      const nextAvailable = wallet.available - price;
      const nextReserved = wallet.reserved + price;
      this.db.prepare("UPDATE wallets SET available = ?, reserved = ?, updated_at = ? WHERE user_id = ?")
        .run(nextAvailable, nextReserved, now, userId);
      jobId = uuid();
      this.db.prepare(`
        INSERT INTO jobs (
          id, user_id, operation, status, price, idempotency_key, request_hash, spec_id,
          parent_image_id, instruction, preserve_instructions, provider_mode, created_at
        ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        jobId, userId, operation, price, idempotencyKey, requestHash, specId || null,
        parentImageId || null, instruction, preserveInstructions, this.config.providerMode, now
      );
      this.db.prepare(`
        INSERT INTO transactions (
          id, user_id, job_id, type, available_delta, reserved_delta, spent_delta,
          available_after, reserved_after, spent_after, description, actor_id, created_at
        ) VALUES (?, ?, ?, 'reserve', ?, ?, 0, ?, ?, ?, ?, ?, ?)
      `).run(
        uuid(), userId, jobId, -price, price, nextAvailable, nextReserved, wallet.spent,
        `${operation === "generate" ? "新生成" : "继续调整"}预留 ${price} Credits`, userId, now
      );
      created = true;
      return { job: this.getJob(userId, jobId), duplicate: false };
    });
    if (created) setTimeout(() => this.tick().catch((error) => console.error("job queue failed", error)), this.config.queueDelayMs ?? 10);
    return result;
  }

  getJob(userId, jobId) {
    const row = this.db.prepare(`
      SELECT j.*, i.id AS image_id, i.version_number, i.storage_path, i.mime_type AS image_mime_type,
             i.size_bytes AS image_size_bytes, i.created_at AS image_created_at
      FROM jobs j LEFT JOIN images i ON i.job_id = j.id
      WHERE j.id = ? AND j.user_id = ?
    `).get(jobId, userId);
    if (!row) throw new HttpError(404, "job_not_found", "任务不存在");
    return mapJob(row);
  }

  listJobs(userId) {
    return this.db.prepare(`
      SELECT j.*, i.id AS image_id, i.version_number, i.storage_path, i.mime_type AS image_mime_type,
             i.size_bytes AS image_size_bytes, i.created_at AS image_created_at
      FROM jobs j LEFT JOIN images i ON i.job_id = j.id
      WHERE j.user_id = ? ORDER BY j.created_at DESC LIMIT 100
    `).all(userId).map(mapJob);
  }

  listImages(userId) {
    return this.db.prepare(`
      SELECT i.*, j.operation, j.provider_mode FROM images i JOIN jobs j ON j.id = i.job_id
      WHERE i.user_id = ? ORDER BY i.created_at DESC
    `).all(userId).map(mapImage);
  }

  getImage(userId, imageId) {
    const row = this.db.prepare(`
      SELECT i.*, j.operation, j.provider_mode FROM images i JOIN jobs j ON j.id = i.job_id
      WHERE i.id = ? AND i.user_id = ?
    `).get(imageId, userId);
    if (!row) throw new HttpError(404, "image_not_found", "图片不存在或无权访问");
    if (!fs.existsSync(row.storage_path)) throw new HttpError(410, "image_file_missing", "图片文件已丢失");
    return row;
  }

  imageVersions(userId, imageId) {
    const image = this.getImage(userId, imageId);
    const chain = [mapImage(image)];
    let current = image;
    const seen = new Set([image.id]);
    while (current.parent_image_id && !seen.has(current.parent_image_id)) {
      const parent = this.db.prepare(`
        SELECT i.*, j.operation, j.provider_mode FROM images i JOIN jobs j ON j.id = i.job_id
        WHERE i.id = ? AND i.user_id = ?
      `).get(current.parent_image_id, userId);
      if (!parent) break;
      seen.add(parent.id);
      chain.push(mapImage(parent));
      current = parent;
    }
    return chain.reverse();
  }

  createUser(input, actorId) {
    const username = normalizeUsername(input.username);
    const displayName = text(input.displayName || username, "显示名称", 60, true);
    const password = validatePassword(input.password);
    const role = String(input.role || "member").trim().toLowerCase();
    if (!["member", "admin"].includes(role)) {
      throw new HttpError(422, "validation_error", "账户角色无效");
    }
    const initialCredits = input.initialCredits === undefined || input.initialCredits === null || input.initialCredits === ""
      ? Math.max(0, Number(this.config.initialCredits) || 0)
      : Number(input.initialCredits);
    if (!Number.isInteger(initialCredits) || initialCredits < 0 || initialCredits > 100000) {
      throw new HttpError(422, "validation_error", "初始额度需为 0-100000 的整数");
    }
    if (this.db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) {
      throw new HttpError(409, "username_exists", "账号已存在");
    }

    const id = uuid();
    const now = isoNow();
    try {
      withTransaction(this.db, () => {
        this.db.prepare(`
          INSERT INTO users (id, username, display_name, password_hash, role, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, username, displayName, hashPassword(password), role, now);
        this.db.prepare(`
          INSERT INTO wallets (user_id, available, reserved, spent, updated_at)
          VALUES (?, ?, 0, 0, ?)
        `).run(id, initialCredits, now);
        if (initialCredits > 0) {
          this.db.prepare(`
            INSERT INTO transactions (
              id, user_id, job_id, type, available_delta, reserved_delta, spent_delta,
              available_after, reserved_after, spent_after, description, actor_id, created_at
            ) VALUES (?, ?, NULL, 'grant', ?, 0, 0, ?, 0, 0, '管理员创建账户初始额度', ?, ?)
          `).run(uuid(), id, initialCredits, initialCredits, actorId, now);
        }
      });
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error?.message || ""))) {
        throw new HttpError(409, "username_exists", "账号已存在");
      }
      throw error;
    }
    return this.listUsers().find((user) => user.id === id);
  }

  changePassword(userId, currentPassword, newPassword) {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    if (!row) throw new HttpError(404, "user_not_found", "账户不存在");
    if (!verifyPassword(String(currentPassword || ""), row.password_hash)) {
      throw new HttpError(401, "current_password_invalid", "当前密码不正确");
    }
    const password = validatePassword(newPassword, "新密码");
    if (String(currentPassword) === password) {
      throw new HttpError(422, "password_unchanged", "新密码不能与当前密码相同");
    }
    this.revokeCredentials(userId, hashPassword(password));
    return { userId, username: row.username };
  }

  resetPassword(userId, newPassword) {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    if (!row) throw new HttpError(404, "user_not_found", "账户不存在");
    const password = validatePassword(newPassword, "新密码");
    this.revokeCredentials(userId, hashPassword(password));
    return { userId, username: row.username };
  }

  revokeCredentials(userId, passwordHash) {
    withTransaction(this.db, () => {
      this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
      this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM api_tokens WHERE user_id = ?").run(userId);
    });
  }

  listUsers() {
    return this.db.prepare(`
      SELECT u.id, u.username, u.display_name, u.role, u.created_at,
             w.available, w.reserved, w.spent
      FROM users u JOIN wallets w ON w.user_id = u.id ORDER BY u.created_at ASC
    `).all().map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      createdAt: row.created_at,
      wallet: { available: row.available, reserved: row.reserved, spent: row.spent }
    }));
  }

  buildPrompt(operation, spec, instruction, preserveInstructions) {
    if (operation === "generate") {
      return [
        "生成一张固定尺寸、单张的产品说明示意图底图。",
        "只绘制产品主体、结构、材质、连接关系与必要的安装关系；不要在图内绘制标题、中文、数字、尺寸、编号、标签、水印或边框。",
        "顶部约 18% 与底部约 26% 保持干净、简洁、低干扰的留白，供服务端确定性排版层叠加文字。",
        `产品：${spec?.productName || "未命名产品"}`,
        `已知尺寸：${(spec?.dimensions || []).map((item) => `${item.name} ${item.value}${item.unit}（${item.sourceRef}）`).join("；") || "无"}`,
        `材质：${spec?.material || "待确认"}`,
        `安装：${spec?.mounting || "待确认"}`,
        `标注：${(spec?.labels || []).join("；") || "无"}`,
        `版式：${spec?.layout || "横向中文说明书风格"}`,
        `未知项：${(spec?.unknowns || []).join("；") || "无"}`,
        "不得补充资料中不存在或待确认的尺寸、孔位、承载结论。输出仅作为说明示意图，须人工复核。",
        `用户附加要求：${instruction}`
      ].join("\n");
    }
    return [
      "基于所附父图进行继续调整，保留父图的整体结构、尺寸、文字和其他未要求改变的内容。",
      `修改指令：${instruction}`,
      `必须保留：${preserveInstructions || "父图结构、尺寸和其他文字"}`,
      "不得静默改成重新生成；输出为新的独立版本，父图继续保留。"
    ].join("\n");
  }

  recoverInterruptedJobs() {
    const now = isoNow();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const running = this.db.prepare("SELECT id FROM jobs WHERE status = 'running'").all();
      for (const job of running) {
        this.db.prepare(`
          UPDATE jobs SET status = 'reconciling', error_code = 'restart_interrupted',
            error_message = '服务重启时调用进行中，结果待核查，未自动重新付费调用', finished_at = ?
          WHERE id = ? AND status = 'running'
        `).run(now, job.id);
        this.db.prepare(`
          UPDATE provider_attempts SET outcome = 'uncertain', finished_at = ?,
            error_message = COALESCE(error_message, '服务重启，调用结果未知')
          WHERE job_id = ? AND outcome = 'pending'
        `).run(now, job.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async tick() {
    const queued = this.db.prepare("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 4").all();
    for (const job of queued) {
      if (this.activeJobs.has(job.id)) continue;
      this.activeJobs.add(job.id);
      this.processJob(job.id)
        .catch((error) => console.error("job processing failed", job.id, error))
        .finally(() => this.activeJobs.delete(job.id));
    }
  }

  claimJob(jobId) {
    return withTransaction(this.db, () => {
      const job = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
      if (!job || job.status !== "queued") return null;
      this.db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
        .run(isoNow(), jobId);
      return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
    });
  }

  async processJob(jobId) {
    const job = this.claimJob(jobId);
    if (!job) return;
    if (!this.hasReservedFunds(job)) {
      this.failUnfundedJob(job);
      return;
    }
    const spec = job.spec_id ? this.getSpec(job.user_id, job.spec_id) : null;
    const parent = job.parent_image_id ? this.getImage(job.user_id, job.parent_image_id) : null;
    const referenceFiles = (spec?.inputAssetIds || []).map((assetId) => this.getAsset(job.user_id, assetId).storage_path);
    const attemptId = uuid();
    const startedAt = isoNow();
    this.db.prepare(`
      INSERT INTO provider_attempts (id, job_id, mode, started_at, outcome)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(attemptId, job.id, this.config.providerMode, startedAt);
    const outputBase = path.join(this.config.outputsDir, `${job.id}-${uuid()}`);
    const prompt = this.buildPrompt(job.operation, spec, job.instruction, job.preserve_instructions);
    const request = {
      jobId: job.id,
      operation: job.operation,
      prompt,
      instruction: job.instruction,
      preserveInstructions: job.preserve_instructions,
      spec,
      referenceFiles,
      parentImagePath: parent?.storage_path || null,
      outputPath: outputBase
    };
    try {
      const result = job.operation === "edit"
        ? await this.provider.edit(request)
        : await this.provider.generate(request);
      const stats = await fsPromises.stat(result.outputPath);
      if (!stats.isFile() || stats.size === 0) throw new ProviderOutcomeUncertain("供应商未产生可读取图片", "empty_provider_output");
      this.completeJob(job, result, stats.size);
    } catch (error) {
      if (error instanceof ProviderDefiniteFailure) {
        this.failJob(job, attemptId, error.code, error.message, false);
      } else if (error instanceof ProviderOutcomeUncertain) {
        this.failJob(job, attemptId, error.code, error.message, true);
      } else {
        this.failJob(job, attemptId, "unexpected_provider_error", `未预期错误，结果按待核查处理：${error.message}`, true);
      }
    }
  }

  hasReservedFunds(job) {
    const wallet = this.db.prepare("SELECT reserved FROM wallets WHERE user_id = ?").get(job.user_id);
    return Boolean(wallet && wallet.reserved >= job.price);
  }

  failUnfundedJob(job) {
    const now = isoNow();
    this.db.prepare(`
      UPDATE jobs SET status = 'failed', error_code = 'reservation_missing',
        error_message = '任务预留额度缺失，未调用 Image Provider', finished_at = ?
      WHERE id = ? AND status = 'running'
    `).run(now, job.id);
  }

  completeJob(job, result, sizeBytes) {
    withTransaction(this.db, () => {
      const current = this.db.prepare("SELECT status FROM jobs WHERE id = ?").get(job.id);
      if (current?.status !== "running") return;
      const wallet = this.db.prepare("SELECT * FROM wallets WHERE user_id = ?").get(job.user_id);
      const nextReserved = Math.max(0, wallet.reserved - job.price);
      const nextSpent = wallet.spent + job.price;
      const now = isoNow();
      const versionRow = this.db.prepare("SELECT COALESCE(MAX(version_number), 0) AS version FROM images WHERE user_id = ?")
        .get(job.user_id);
      const imageId = uuid();
      this.db.prepare(`
        INSERT INTO images (
          id, user_id, job_id, parent_image_id, version_number, storage_path, mime_type, size_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        imageId, job.user_id, job.id, job.parent_image_id, versionRow.version + 1,
        result.outputPath, result.mimeType, sizeBytes, now
      );
      this.db.prepare("UPDATE wallets SET available = ?, reserved = ?, spent = ?, updated_at = ? WHERE user_id = ?")
        .run(wallet.available, nextReserved, nextSpent, now, job.user_id);
      this.db.prepare(`
        UPDATE jobs SET status = 'succeeded', provider_request_id = ?, finished_at = ?,
          error_code = NULL, error_message = NULL WHERE id = ?
      `).run(result.providerRequestId || null, now, job.id);
      this.db.prepare(`
        UPDATE provider_attempts SET outcome = 'succeeded', finished_at = ?, request_id = ?
        WHERE job_id = ? AND outcome = 'pending'
      `).run(now, result.providerRequestId || null, job.id);
      this.db.prepare(`
        INSERT INTO transactions (
          id, user_id, job_id, type, available_delta, reserved_delta, spent_delta,
          available_after, reserved_after, spent_after, description, actor_id, created_at
        ) VALUES (?, ?, ?, 'consume', 0, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuid(), job.user_id, job.id, -job.price, job.price, wallet.available, nextReserved, nextSpent,
        `${job.operation === "generate" ? "新生成" : "继续调整"}完成，消费 ${job.price} Credits`,
        job.user_id, now
      );
    });
  }

  failJob(job, attemptId, code, message, uncertain) {
    withTransaction(this.db, () => {
      const current = this.db.prepare("SELECT status FROM jobs WHERE id = ?").get(job.id);
      if (current?.status !== "running") return;
      const now = isoNow();
      if (uncertain) {
        this.db.prepare(`
          UPDATE jobs SET status = 'reconciling', error_code = ?, error_message = ?, finished_at = ?
          WHERE id = ?
        `).run(code, message.slice(0, 1000), now, job.id);
        this.db.prepare(`UPDATE provider_attempts SET outcome = 'uncertain', finished_at = ?, error_message = ? WHERE id = ?`)
          .run(now, message.slice(0, 1000), attemptId);
        return;
      }
      const wallet = this.db.prepare("SELECT * FROM wallets WHERE user_id = ?").get(job.user_id);
      const nextAvailable = wallet.available + job.price;
      const nextReserved = Math.max(0, wallet.reserved - job.price);
      this.db.prepare("UPDATE wallets SET available = ?, reserved = ?, updated_at = ? WHERE user_id = ?")
        .run(nextAvailable, nextReserved, now, job.user_id);
      this.db.prepare(`
        UPDATE jobs SET status = 'failed', error_code = ?, error_message = ?, finished_at = ? WHERE id = ?
      `).run(code, message.slice(0, 1000), now, job.id);
      this.db.prepare(`UPDATE provider_attempts SET outcome = 'failed', finished_at = ?, error_message = ? WHERE id = ?`)
        .run(now, message.slice(0, 1000), attemptId);
      this.db.prepare(`
        INSERT INTO transactions (
          id, user_id, job_id, type, available_delta, reserved_delta, spent_delta,
          available_after, reserved_after, spent_after, description, actor_id, created_at
        ) VALUES (?, ?, ?, 'release', ?, ?, 0, ?, ?, ?, ?, ?, ?)
      `).run(
        uuid(), job.user_id, job.id, job.price, -job.price, nextAvailable, nextReserved, wallet.spent,
        `任务明确失败，释放 ${job.price} Credits`, job.user_id, now
      );
    });
  }
}
