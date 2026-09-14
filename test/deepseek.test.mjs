/**
 * @file deepseek.test.mjs
 * @description 验证 AI 结果合并后的完整度状态，防止缺失词条被错误标记为已完成。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildPrompt, mergeEnrichment } from "../src/deepseek.mjs";

const baseWord = {
  term: "例",
  reading: "れい",
  partOfSpeech: { category: "名词", detail: "", conjugationClass: "", transitivity: "" },
  meanings: ["例子"],
  jlpt: "未定",
  tags: [],
  conjugations: [],
  examples: [{ japanese: "これは例です。", chinese: "这是例子。" }],
  notes: "",
};

test("补全后仍缺 JLPT 时保持 pending", () => {
  const result = mergeEnrichment(baseWord, { jlpt: "未定" });
  assert.equal(result.aiStatus, "pending");
});

test("无法归入 JLPT 的词条可用不适用完成补全", () => {
  const result = mergeEnrichment(baseWord, { jlpt: "不适用" });
  assert.equal(result.jlpt, "不适用");
  assert.equal(result.aiStatus, "complete");
});

test("动词没有活用时不能标记为 complete", () => {
  const verb = { ...baseWord, jlpt: "N4", partOfSpeech: { ...baseWord.partOfSpeech, category: "动词" } };
  const result = mergeEnrichment(verb, {});
  assert.equal(result.aiStatus, "pending");
});

test("提示词要求在没有明确词表归属时推断相当难度", () => {
  const prompt = buildPrompt({ term: "見惚れる", jlpt: "未定" }, 2, "missing", []);
  assert.match(prompt, /必须自行推断“JLPT 相当难度”/);
  assert.match(prompt, /常用频率/);
  assert.match(prompt, /普通口语、惯用语、复合词和书面表达仍应尽量给出 N1～N5/);
  assert.match(prompt, /只有专有名词、明显错误或无法还原的残缺片段/);
});
