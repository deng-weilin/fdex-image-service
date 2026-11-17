import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadDotEnv(file = path.join(rootDir, ".env")) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function integerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function booleanEnv(name, fallback) {
  const value = String(process.env[name] ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

export function getConfig(overrides = {}) {
  loadDotEnv(overrides.envFile);
  const dataDir = path.resolve(overrides.dataDir ?? process.env.DATA_DIR ?? path.join(rootDir, "runtime"));
  const appEnvironment = String(overrides.appEnvironment ?? process.env.APP_ENV ?? "development").trim().toLowerCase();
  if (!["development", "test", "production"].includes(appEnvironment)) {
    throw new Error("APP_ENV must be development, test, or production");
  }
  const isProduction = appEnvironment === "production";
  const appOrigin = String(overrides.appOrigin ?? process.env.APP_ORIGIN ?? "http://127.0.0.1:4310").replace(/\/$/, "");
  if (isProduction && !appOrigin.startsWith("https://")) {
    throw new Error("APP_ORIGIN must use https:// when APP_ENV=production");
  }
  const seedDemoAccounts = overrides.seedDemoAccounts ?? booleanEnv("SEED_DEMO_ACCOUNTS", !isProduction);
  if (isProduction && seedDemoAccounts) {
    throw new Error("SEED_DEMO_ACCOUNTS must be false when APP_ENV=production");
  }
  const demoPassword = String(overrides.demoPassword ?? process.env.DEMO_PASSWORD ?? "");
  if (seedDemoAccounts && demoPassword.length < 8) {
    throw new Error("DEMO_PASSWORD must be at least 8 characters when demo accounts are enabled");
  }
  const adminPassword = String(overrides.adminPassword ?? process.env.ADMIN_PASSWORD ?? "");
  if (adminPassword && adminPassword.length < 12) {
    throw new Error("ADMIN_PASSWORD must be at least 12 characters");
  }
  const adminUsername = String(overrides.adminUsername ?? process.env.ADMIN_USERNAME ?? "instructor").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(adminUsername)) {
    throw new Error("ADMIN_USERNAME must be 3-32 lowercase letters, numbers, or underscores");
  }
  const config = {
    rootDir,
    publicDir: path.join(rootDir, "public"),
    dataDir,
    dbFile: path.join(dataDir, "image-service.sqlite"),
    uploadsDir: path.join(dataDir, "uploads"),
    outputsDir: path.join(dataDir, "outputs"),
    host: process.env.HOST || "127.0.0.1",
    port: integerEnv("PORT", 4310),
    appEnvironment,
    appOrigin,
    sessionDays: 7,
    generatePrice: integerEnv("CREDITS_GENERATE", 10),
    editPrice: integerEnv("CREDITS_EDIT", 4),
    initialCredits: overrides.initialCredits ?? integerEnv("INITIAL_CREDITS", isProduction ? 0 : 100),
    duplicateSubmitWindowMs: integerEnv("DUPLICATE_SUBMIT_WINDOW_MS", 3000),
    queueDelayMs: integerEnv("QUEUE_DELAY_MS", 10),
    authRateLimitMax: overrides.authRateLimitMax ?? integerEnv("AUTH_RATE_LIMIT_MAX", 20),
    authRateLimitWindowMs: overrides.authRateLimitWindowMs ?? integerEnv("AUTH_RATE_LIMIT_WINDOW_MS", 300_000),
    providerMode: process.env.IMAGE_PROVIDER === "live" ? "live" : "mock",
    imageApiBaseUrl: (process.env.IMAGE_API_BASE_URL || "").replace(/\/$/, ""),
    imageApiKey: process.env.IMAGE_API_KEY || "",
    imageApiStyle: process.env.IMAGE_API_STYLE || "openai",
    imageGenerateModel: process.env.IMAGE_GENERATE_MODEL || "",
    imageEditModel: process.env.IMAGE_EDIT_MODEL || "",
    imageSize: process.env.IMAGE_SIZE || "1536x1024",
    imageQuality: process.env.IMAGE_QUALITY || "",
    imageOutputFormat: process.env.IMAGE_OUTPUT_FORMAT || "",
    imageResponseFormat: process.env.IMAGE_RESPONSE_FORMAT || "",
    imageApiTimeoutMs: integerEnv("IMAGE_API_TIMEOUT_MS", 180000),
    imageNegativePrompt: process.env.IMAGE_NEGATIVE_PROMPT || "",
    imagePromptExtend: (process.env.IMAGE_PROMPT_EXTEND ?? "false") === "true",
    imageWatermark: (process.env.IMAGE_WATERMARK ?? "false") === "true",
    imageTextOverlay: (process.env.IMAGE_TEXT_OVERLAY ?? "true") === "true",
    seedDemoAccounts,
    demoPassword,
    allowRegistration: overrides.allowRegistration ?? booleanEnv("ALLOW_REGISTRATION", !isProduction),
    secureCookies: overrides.secureCookies ?? booleanEnv("COOKIE_SECURE", appOrigin.startsWith("https://")),
    trustProxy: overrides.trustProxy ?? booleanEnv("TRUST_PROXY", false),
    adminUsername,
    adminDisplayName: String(overrides.adminDisplayName ?? process.env.ADMIN_DISPLAY_NAME ?? "系统管理员").trim(),
    adminPassword,
    adminInitialCredits: overrides.adminInitialCredits ?? integerEnv("ADMIN_INITIAL_CREDITS", seedDemoAccounts ? 500 : 0)
  };
  return { ...config, ...overrides };
}
