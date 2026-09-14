/**
 * @file word-schema.test.mjs
 * @description 验证 AI 词性字段的别名兼容与分类兜底推断，防止已补全词条仍显示“未分类”。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { fillMissingStoredCategory, isWordEligibleForPractice, normalizeAiPayload, normalizeStoredWord, normalizeWordPatch } from "../src/word-schema.mjs";

test("保留标准 partOfSpeech.category 分类", () => {
  const result = normalizeAiPayload({ partOfSpeech: { category: "動詞", detail: "五段活用" } });
  assert.equal(result.partOfSpeech.category, "动词");
});

test("category 缺失时从词性细分和活用信息推断", () => {
  const result = normalizeAiPayload({
    partOfSpeech: { detail: "五段活用他動詞", conjugationClass: "五段", transitivity: "他動詞" },
  });
  assert.equal(result.partOfSpeech.category, "动词");
});

test("category 缺失时优先从标签识别惯用表达", () => {
  const result = normalizeAiPayload({
    partOfSpeech: { detail: "名詞を修飾する表現" },
    tags: ["連語", "慣用表現"],
  });
  assert.equal(result.partOfSpeech.category, "惯用语");
});

test("兼容模型常见的 part_of_speech 和顶层 category 字段", () => {
  const snakeCase = normalizeAiPayload({ part_of_speech: { category: "名詞", detail: "普通名词" } });
  const topLevel = normalizeAiPayload({ category: "副詞" });
  assert.equal(snakeCase.partOfSpeech.category, "名词");
  assert.equal(topLevel.partOfSpeech.category, "副词");
});

test("无法识别的非空分类归入其他", () => {
  const result = normalizeAiPayload({ partOfSpeech: { category: "接頭詞" } });
  assert.equal(result.partOfSpeech.category, "其他");
});

test("读取旧词条时恢复已经存在于细分信息中的分类", () => {
  const word = fillMissingStoredCategory({
    term: "晴らす",
    partOfSpeech: { category: "未分类", detail: "五段活用他动词", conjugationClass: "五段", transitivity: "他动词" },
    tags: ["五段", "他动词"],
  });
  assert.equal(word.partOfSpeech.category, "动词");
});

test("分类推断忽略‘非动词’等否定描述", () => {
  const word = fillMissingStoredCategory({
    term: "訳",
    partOfSpeech: { category: "未分类", detail: "名词。读作「わけ」时表示理由；非动词，无活用。", conjugationClass: "无（名词）", transitivity: "无（名词）" },
    tags: ["名词"],
  });
  assert.equal(word.partOfSpeech.category, "名词");
});

test("读取旧词条时把界面不支持的分类归一化", () => {
  const word = fillMissingStoredCategory({
    term: "～するかよ",
    partOfSpeech: { category: "文末表現", detail: "反问语气的文末表达" },
    tags: ["口语", "句型"],
  });
  assert.equal(word.partOfSpeech.category, "语法结构");
});

test("学习分类仅接受正常学习和暂不学习", () => {
  assert.equal(normalizeWordPatch({ studyStatus: "paused" }).studyStatus, "paused");
  assert.equal(normalizeWordPatch({ studyStatus: "unexpected" }).studyStatus, "active");
});

test("旧词条默认可练习，暂不学习词条从记忆与考核候选中排除", () => {
  assert.equal(normalizeStoredWord({ term: "既有词条" }).studyStatus, "active");
  assert.equal(isWordEligibleForPractice({}), true);
  assert.equal(isWordEligibleForPractice({ studyStatus: "paused" }), false);
});

test("JLPT 只接受标准等级并兼容不适用别名", () => {
  assert.equal(normalizeAiPayload({ jlpt: "JLPT N３" }).jlpt, "N3");
  assert.equal(normalizeAiPayload({ jlpt: "不適用" }).jlpt, "不适用");
  assert.equal(normalizeAiPayload({ jlpt: "未知" }).jlpt, "未定");
});
