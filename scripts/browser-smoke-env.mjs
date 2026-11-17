import fs from "node:fs";
import path from "node:path";
import { loadDotEnv } from "../src/config.js";

export function resolveSmokeBrowser(root) {
  loadDotEnv(path.join(root, ".env"));
  const candidates = [
    process.env.EDGE_PATH,
    process.env.BROWSER_PATH,
    process.env["PROGRAMFILES(X86)"]
      ? path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe")
      : "",
    process.env.PROGRAMFILES
      ? path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe")
      : "",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe")
      : ""
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("Edge was not found. Set EDGE_PATH to a Chromium-compatible browser executable.");
  return executable;
}

export function smokeCredentials(defaultUsername) {
  const username = process.env.SMOKE_USERNAME || defaultUsername;
  const password = process.env.SMOKE_PASSWORD || process.env.DEMO_PASSWORD;
  if (!password) throw new Error("Set SMOKE_PASSWORD or DEMO_PASSWORD before running browser smoke tests.");
  return { username, password };
}
