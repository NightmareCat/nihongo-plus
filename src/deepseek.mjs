/**
 * @file deepseek.mjs
 * @description DeepSeek JSON 补全服务；仅生成缺失字段，不覆盖人工维护内容。
 */

import crypto from "node:crypto";
import { fetchJsonWithTimeout } from "./fetch-json.mjs";
import { getActiveAiRuntime } from "./settings.mjs";
import { normalizeAiPayload } from "./word-schema.mjs";

const CONJUGATION_OPTIONS = [
  "辞書形", "ます形", "て形", "た形", "ない形", "なかった形", "意向形", "命令形", "可能形", "被动形", "使役形", "使役被动形", "条件形（ば）", "条件形（たら）",
];
const CATEGORY_OPTIONS = ["名词", "动词", "形容词", "副词", "语法结构", "固定搭配", "惯用语", "接续词", "感叹词", "助词", "其他"];

function buildPrompt(word, exampleCount, mode, fields) {
  const action = mode === "replace"
    ? "重新生成除词条本身和个人笔记之外的全部词典信息。"
    : mode === "fields"
      ? `重点重新生成这些字段：${fields.join("、")}；其余字段仍需原样返回。`
      : "只补充现有为空的字段，已有内容原样返回。";
  return `请处理这个日语词条：${word.term}\n现有数据：${JSON.stringify(word)}\n要求：\n1. 返回严格 JSON，不要 Markdown。\n2. 中文释义简洁准确。\n3. 日语例句自然，并用 HTML ruby 标签给例句中的汉字注音，例如 <ruby>勉強<rt>べんきょう</rt></ruby>；标签前不要添加反斜杠。\n4. partOfSpeech.category 必须填写且只能是以下之一：${CATEGORY_OPTIONS.join("、")}。若为动词，指出一段/五段/不规则以及自动词/他动词；若为形容词，指出い形容词或な形容词。\n5. 动词优先维护这些活用：${CONJUGATION_OPTIONS.join("、")}。形容词维护现在肯定、现在否定、过去肯定、过去否定、て形、条件形。每个活用提供一个带 ruby 注音的例句。\n6. 主例句数量为 ${exampleCount}。\n7. ${action}`;
}

function cleanGenerated(value) {
  if (typeof value === "string") return value.replace(/\\([<>])/g, "$1");
  if (Array.isArray(value)) return value.map(cleanGenerated);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanGenerated(item)]));
  return value;
}

export async function enrichWord(word, exampleCount = 2, mode = "missing", fields = [], signal) {
  const runtime = await getActiveAiRuntime();
  if (!runtime.apiKey) {
    const error = new Error(`尚未配置 ${runtime.label} API Key`);
    error.statusCode = 503;
    throw error;
  }

  const headers = {
    Authorization: `Bearer ${runtime.apiKey}`,
    "Content-Type": "application/json",
  };
  if (runtime.provider === "opencode-go") {
    // OpenCode Go 要求客户端标识和稳定会话头；每个词使用独立 ID，保证并行任务不共享会话。
    headers["User-Agent"] = "nihongo-plus/0.2";
    headers["x-opencode-session"] = crypto.randomUUID();
  }

  const { response, payload } = await fetchJsonWithTimeout(`${runtime.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model: runtime.model,
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: `你是严谨的日语词典编辑。输出一个 JSON 对象，字段为 reading、partOfSpeech、meanings、jlpt、tags、conjugations、examples、notes。所有末端字段必须是字符串，不得用对象代替字符串。partOfSpeech 包含字符串 category、detail、conjugationClass、transitivity，其中 category 必填且只能是：${CATEGORY_OPTIONS.join("、")}。meanings 和 tags 是字符串数组；conjugations 每项包含字符串 name、form、example（日文）、exampleChinese（中文）；examples 每项包含字符串 japanese、chinese。`,
        },
        { role: "user", content: buildPrompt(word, Math.min(5, Math.max(1, Number(exampleCount) || 2)), mode, fields) },
      ],
    }),
  }, runtime.requestTimeoutSeconds * 1_000);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `DeepSeek 请求失败（${response.status}）`);
    error.statusCode = response.status;
    throw error;
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek 未返回可用内容");
  const json = content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  return normalizeAiPayload(cleanGenerated(JSON.parse(json)));
}

export function mergeEnrichment(word, generated, mode = "missing", fields = []) {
  const currentPart = word.partOfSpeech || {};
  const aiPart = generated.partOfSpeech || {};
  const missing = {
    reading: word.reading || generated.reading || "",
    partOfSpeech: {
      category: currentPart.category && currentPart.category !== "未分类" ? currentPart.category : aiPart.category || "未分类",
      detail: currentPart.detail || aiPart.detail || "",
      conjugationClass: currentPart.conjugationClass || aiPart.conjugationClass || "",
      transitivity: currentPart.transitivity || aiPart.transitivity || "",
    },
    meanings: word.meanings?.length ? word.meanings : generated.meanings || [],
    jlpt: word.jlpt && word.jlpt !== "未定" ? word.jlpt : generated.jlpt || "未定",
    tags: word.tags?.length ? word.tags : generated.tags || [],
    conjugations: word.conjugations?.length ? word.conjugations : generated.conjugations || [],
    examples: word.examples?.length ? word.examples : generated.examples || [],
    notes: word.notes || generated.notes || "",
    aiStatus: "complete",
  };
  if (mode === "replace") return {
    reading: generated.reading || "",
    partOfSpeech: generated.partOfSpeech || { category: "未分类", detail: "", conjugationClass: "", transitivity: "" },
    meanings: generated.meanings || [],
    jlpt: generated.jlpt || "未定",
    tags: generated.tags || [],
    conjugations: generated.conjugations || [],
    examples: generated.examples || [],
    notes: word.notes || generated.notes || "",
    aiStatus: "complete",
  };
  if (mode === "fields") {
    const selected = new Set(fields);
    return {
      ...word,
      reading: selected.has("reading") ? generated.reading || "" : word.reading,
      partOfSpeech: selected.has("partOfSpeech") ? generated.partOfSpeech || word.partOfSpeech : word.partOfSpeech,
      meanings: selected.has("meanings") ? generated.meanings || [] : word.meanings,
      jlpt: selected.has("jlpt") ? generated.jlpt || "未定" : word.jlpt,
      tags: selected.has("tags") ? generated.tags || [] : word.tags,
      conjugations: selected.has("conjugations") ? generated.conjugations || [] : word.conjugations,
      examples: selected.has("examples") ? generated.examples || [] : word.examples,
      notes: word.notes,
      aiStatus: "complete",
    };
  }
  return missing;
}

export const conjugationOptions = CONJUGATION_OPTIONS;
