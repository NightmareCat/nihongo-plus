/**
 * @file settings.test.mjs
 * @description 验证学习与测试等级设置的默认值、排序及非法值过滤。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { normalizePracticeJlptLevels, normalizeQuizPrefetchCount } from "../src/settings.mjs";

test("未提供等级时默认启用 N5 到 N1", () => {
  assert.deepEqual(normalizePracticeJlptLevels(undefined), ["N5", "N4", "N3", "N2", "N1"]);
});

test("等级多选值按固定顺序去重并过滤非法类别", () => {
  assert.deepEqual(normalizePracticeJlptLevels(["N1", "N3", "N3", "不适用", "N0"]), ["N3", "N1"]);
});

test("允许取消全部等级", () => {
  assert.deepEqual(normalizePracticeJlptLevels([]), []);
});

test("试题储备数量默认 2，并严格限制为 1 到 3", () => {
  assert.equal(normalizeQuizPrefetchCount(undefined), 2);
  assert.equal(normalizeQuizPrefetchCount(0), 1);
  assert.equal(normalizeQuizPrefetchCount("3"), 3);
  assert.equal(normalizeQuizPrefetchCount(20), 3);
});
