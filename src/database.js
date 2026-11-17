import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashPassword, uuid } from "./security.js";

export function openDatabase(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  fs.mkdirSync(config.outputsDir, { recursive: true });
  const db = new DatabaseSync(config.dbFile);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS wallets (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      available INTEGER NOT NULL,
      reserved INTEGER NOT NULL,
      spent INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      job_id TEXT,
      type TEXT NOT NULL,
      available_delta INTEGER NOT NULL,
      reserved_delta INTEGER NOT NULL,
      spent_delta INTEGER NOT NULL,
      available_after INTEGER NOT NULL,
      reserved_after INTEGER NOT NULL,
      spent_after INTEGER NOT NULL,
      description TEXT NOT NULL,
      actor_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS drawing_specs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      raw_input TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      operation TEXT NOT NULL,
      status TEXT NOT NULL,
      price INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      spec_id TEXT,
      parent_image_id TEXT,
      instruction TEXT NOT NULL,
      preserve_instructions TEXT NOT NULL,
      provider_mode TEXT NOT NULL,
      provider_request_id TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      UNIQUE(user_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS provider_attempts (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      mode TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      request_id TEXT,
      outcome TEXT,
      error_message TEXT
    );
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      parent_image_id TEXT REFERENCES images(id),
      version_number INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_assets_user ON assets(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_specs_user ON drawing_specs(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_recent_request ON jobs(user_id, request_hash, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_images_user ON images(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC);
  `);
  seedInitialAccounts(db, config);
  return db;
}

function isoNow() {
  return new Date().toISOString();
}

function seedInitialAccounts(db, config) {
  const accounts = [];
  if (config.seedDemoAccounts) {
    accounts.push(
      ["student_a", "演示成员 A", "member", config.initialCredits, config.demoPassword],
      ["student_b", "演示成员 B", "member", config.initialCredits, config.demoPassword]
    );
  }
  const adminPassword = config.adminPassword || (config.seedDemoAccounts ? config.demoPassword : "");
  if (adminPassword) {
    accounts.push([
      config.adminUsername,
      config.adminDisplayName,
      "admin",
      config.adminInitialCredits,
      adminPassword
    ]);
  }
  if (!accounts.length) {
    const userCount = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
    if (config.appEnvironment === "production" && userCount === 0) {
      throw new Error("ADMIN_PASSWORD is required to bootstrap the first production administrator");
    }
    return;
  }

  const insertUser = db.prepare(`
    INSERT INTO users (id, username, display_name, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(username) DO NOTHING
  `);
  const findUser = db.prepare("SELECT id FROM users WHERE username = ?");
  const insertWallet = db.prepare(`
    INSERT INTO wallets (user_id, available, reserved, spent, updated_at) VALUES (?, ?, 0, 0, ?)
    ON CONFLICT(user_id) DO NOTHING
  `);
  const insertTransaction = db.prepare(`
    INSERT INTO transactions (
      id, user_id, job_id, type, available_delta, reserved_delta, spent_delta,
      available_after, reserved_after, spent_after, description, actor_id, created_at
    ) VALUES (?, ?, NULL, 'grant', ?, 0, 0, ?, 0, 0, ?, NULL, ?)
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [username, displayName, role, credits, password] of accounts) {
      insertUser.run(uuid(), username, displayName, hashPassword(password), role, isoNow());
      const user = findUser.get(username);
      const alreadyWallet = db.prepare("SELECT 1 FROM wallets WHERE user_id = ?").get(user.id);
      insertWallet.run(user.id, credits, isoNow());
      if (!alreadyWallet) {
        insertTransaction.run(uuid(), user.id, credits, credits, role === "admin" ? "管理员初始额度" : "演示账户初始额度", isoNow());
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function withTransaction(db, callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
