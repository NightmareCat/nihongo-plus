/**
 * @file config.mjs
 * @description 应用配置中心；集中管理路径、端口与 AI 服务参数。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(new URL("../server.mjs", import.meta.url)));

// 轻量读取项目根目录 .env，避免引入第三方依赖；系统环境变量优先级更高。
try {
  const envText = fs.readFileSync(path.join(rootDir, ".env"), "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || match[2] === "" || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

export const config = {
  rootDir,
  publicDir: path.join(rootDir, "public"),
  legacyLibraryFile: path.join(rootDir, "data", "个人收集.json"),
  libraryDir: path.join(rootDir, "data", "词库"),
  libraryFile: path.join(rootDir, "data", "词库", "个人收集.json"),
  collectionsFile: path.join(rootDir, "data", "子词库.json"),
  quizProgressFile: path.join(rootDir, "data", "学习进度.json"),
  settingsFile: path.join(rootDir, "data", "设置.json"),
  secretsFile: path.join(rootDir, "data", ".secrets.json"),
  port: Number(process.env.PORT || 4173),
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || "",
    baseUrl: (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, ""),
    model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
  },
};
