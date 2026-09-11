/**
 * @file settings.mjs
 * @description 集中管理 AI 提供方、批处理参数与本地密钥；公开配置与敏感信息分离存储。
 */

import fs from "node:fs/promises";
import { config } from "./config.mjs";

const DEFAULTS = {
  schemaVersion: 1,
  aiProvider: "deepseek",
  exampleCount: 2,
  concurrency: 3,
  requestTimeoutSeconds: 60,
  providers: {
    deepseek: { label: "DeepSeek 官方", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" },
    "opencode-go": { label: "OpenCode Go", baseUrl: "https://opencode.ai/zen/go/v1", model: "deepseek-v4.1-flash" },
  },
};
const MAX_CONCURRENCY = 50;
const MIN_REQUEST_TIMEOUT_SECONDS = 10;
const MAX_REQUEST_TIMEOUT_SECONDS = 600;

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return structuredClone(fallback); throw error; }
}

async function writeJson(file, data) {
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(temp, file);
}

export async function getSettings() {
  const saved = await readJson(config.settingsFile, DEFAULTS);
  return {
    ...DEFAULTS,
    ...saved,
    providers: {
      deepseek: { ...DEFAULTS.providers.deepseek, ...saved.providers?.deepseek },
      "opencode-go": { ...DEFAULTS.providers["opencode-go"], ...saved.providers?.["opencode-go"] },
    },
  };
}

export async function getSecrets() {
  return readJson(config.secretsFile, {});
}

export async function getPublicSettings() {
  const [settings, secrets] = await Promise.all([getSettings(), getSecrets()]);
  return {
    ...settings,
    keyConfigured: {
      deepseek: Boolean(secrets.deepseek || process.env.DEEPSEEK_API_KEY),
      "opencode-go": Boolean(secrets["opencode-go"] || process.env.OPENCODE_GO_API_KEY),
    },
  };
}

export async function saveSettings(input = {}) {
  const current = await getSettings();
  const provider = ["deepseek", "opencode-go"].includes(input.aiProvider) ? input.aiProvider : current.aiProvider;
  const next = {
    ...current,
    aiProvider: provider,
    exampleCount: Math.min(5, Math.max(1, Number(input.exampleCount ?? current.exampleCount) || 2)),
    // 并发值同时在服务端限幅，避免绕过浏览器校验提交异常大的任务。
    concurrency: Math.min(MAX_CONCURRENCY, Math.max(1, Math.trunc(Number(input.concurrency ?? current.concurrency) || 3))),
    // 外部模型超时允许按任务规模调整，并限制在 10 秒至 10 分钟之间。
    requestTimeoutSeconds: Math.min(
      MAX_REQUEST_TIMEOUT_SECONDS,
      Math.max(MIN_REQUEST_TIMEOUT_SECONDS, Math.trunc(Number(input.requestTimeoutSeconds ?? current.requestTimeoutSeconds) || 60)),
    ),
    providers: {
      deepseek: {
        ...current.providers.deepseek,
        baseUrl: String(input.providers?.deepseek?.baseUrl || current.providers.deepseek.baseUrl).replace(/\/$/, ""),
        model: String(input.providers?.deepseek?.model || current.providers.deepseek.model),
      },
      "opencode-go": {
        ...current.providers["opencode-go"],
        baseUrl: String(input.providers?.["opencode-go"]?.baseUrl || current.providers["opencode-go"].baseUrl).replace(/\/$/, ""),
        model: String(input.providers?.["opencode-go"]?.model || current.providers["opencode-go"].model),
      },
    },
  };
  await writeJson(config.settingsFile, next);

  // 密钥只在用户实际输入或明确清除时更新，永不写入可同步的设置文件。
  const secrets = await getSecrets();
  if (input.apiKeys?.deepseek) secrets.deepseek = String(input.apiKeys.deepseek).trim();
  if (input.apiKeys?.["opencode-go"]) secrets["opencode-go"] = String(input.apiKeys["opencode-go"]).trim();
  if (input.clearKeys?.deepseek) delete secrets.deepseek;
  if (input.clearKeys?.["opencode-go"]) delete secrets["opencode-go"];
  await writeJson(config.secretsFile, secrets);
  return getPublicSettings();
}

export async function getActiveAiRuntime() {
  const [settings, secrets] = await Promise.all([getSettings(), getSecrets()]);
  const provider = settings.aiProvider;
  const providerSettings = settings.providers[provider];
  const apiKey = provider === "deepseek"
    ? secrets.deepseek || process.env.DEEPSEEK_API_KEY || ""
    : secrets["opencode-go"] || process.env.OPENCODE_GO_API_KEY || "";
  return { provider, apiKey, requestTimeoutSeconds: settings.requestTimeoutSeconds, ...providerSettings };
}
