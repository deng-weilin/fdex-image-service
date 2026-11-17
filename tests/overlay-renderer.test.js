import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with ${code}`));
    });
  });
}

test("local overlay renders deterministic Chinese title and data panel", {
  skip: process.platform !== "win32"
}, async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fdex-overlay-test-"));
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const inputPath = path.join(dataDir, "source.png");
  const outputPath = path.join(dataDir, "result.png");
  const requestPath = path.join(dataDir, "request.json");
  assert.ok(process.env.SystemRoot, "SystemRoot is required for the Windows overlay test");
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const createImage = [
    "Add-Type -AssemblyName System.Drawing;",
    "$bmp=[System.Drawing.Bitmap]::new(1600,1000);",
    "$g=[System.Drawing.Graphics]::FromImage($bmp);",
    "$g.Clear([System.Drawing.Color]::White);",
    "$g.FillRectangle([System.Drawing.Brushes]::DimGray,180,260,1240,380);",
    "$bmp.Save($env:OVERLAY_TEST_INPUT,[System.Drawing.Imaging.ImageFormat]::Png);",
    "$g.Dispose();$bmp.Dispose()"
  ].join(" ");
  await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", createImage], {
    ...process.env,
    OVERLAY_TEST_INPUT: inputPath
  });

  await fs.writeFile(requestPath, JSON.stringify({
    inputPath,
    outputPath,
    productName: "挡车器",
    layout: "横向、中文产品说明图",
    dimensionLines: ["长 530 mm", "宽 140 mm", "高 80 mm"],
    material: "橡胶主体与黄色反光警示条",
    mounting: "地面 M10 膨胀螺栓固定，每件两颗",
    labelsText: "橡胶主体 / 反光警示条 / M10 膨胀螺栓",
    unknownsText: "待确认：精确孔位",
    sourceNote: "课堂资料，参数须人工复核"
  }), "utf8");

  await run(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.resolve("scripts/render-image-overlay.ps1"),
    "-RequestPath",
    requestPath
  ]);

  const image = await fs.readFile(outputPath);
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(image.readUInt32BE(16), 1600);
  assert.equal(image.readUInt32BE(20), 1000);
  assert.ok(image.length > 10_000, `overlay output too small: ${image.length}`);
});
