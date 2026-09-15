/**
 * @file quiz.test.mjs
 * @description 验证 AI 试题约束、答案洗牌和核心词可作为干扰项的规则。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildQuizPrompt, normalizeQuizPayload, QUIZ_TYPES } from "../src/quiz.mjs";

test("提示词将题目严格限制为 N3 并允许核心词成为错误项", () => {
  const prompt = buildQuizPrompt({ term: "見送る", jlpt: "N2" }, QUIZ_TYPES[1], [], false);
  assert.match(prompt, /作为错误答案/);
  assert.match(prompt, /严格控制在 JLPT N3 水平/);
  assert.match(prompt, /词库之外/);
  assert.match(prompt, /必须使用自然、易懂的简体中文/);
  assert.match(prompt, /严禁只写纯日语解释/);
  assert.match(prompt, /每个选项都必须提供 explanation/);
});

test("模型答案在发往界面前会被洗牌且保留正确项映射", () => {
  const normalized = normalizeQuizPayload({
    question: "请选择正确答案",
    stem: "例文",
    options: [
      { text: "甲", explanation: "甲说明" },
      { text: "乙", explanation: "乙说明" },
      { text: "丙", explanation: "丙说明" },
      { text: "丁", explanation: "丁说明" },
    ],
    correctIndex: 1,
    sourceOptionIndex: 1,
    analysis: "解析",
    distractorWords: [{ term: "見送る", meaning: "目送；暂缓", jlpt: "n3" }],
  }, QUIZ_TYPES[2], () => 0, true);
  const correct = normalized.options.find((option) => option.id === normalized.correctOptionId);
  assert.equal(correct.text, "乙");
  assert.deepEqual(normalized.distractorWords, [{ term: "見送る", meaning: "目送；暂缓", jlpt: "N3" }]);
  assert.notDeepEqual(normalized.options.map((option) => option.text), ["甲", "乙", "丙", "丁"]);
});

test("核心词被指定为干扰项时拒绝把它标成正确答案", () => {
  assert.throws(() => normalizeQuizPayload({
    question: "题目",
    options: ["核心词", "二", "三", "四"],
    correctIndex: 0,
    sourceOptionIndex: 0,
  }, QUIZ_TYPES[1], Math.random, false), /未按要求安排核心词/);
});

test("不接受重复选项或无效正确答案", () => {
  assert.throws(() => normalizeQuizPayload({
    question: "题目",
    options: ["同", "同", "三", "四"],
    correctIndex: 8,
  }, QUIZ_TYPES[0]), /结构不完整/);
});
