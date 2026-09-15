/**
 * @file quiz-progress.test.mjs
 * @description 验证单词记忆水平增减和薄弱词抽取权重。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { applyQuizResult, memoryWeight, normalizeMemoryRecord, pickWeightedWord } from "../src/quiz-progress.mjs";

test("新词从中性记忆水平开始，答对上升且答错下降", () => {
  assert.equal(normalizeMemoryRecord().level, 50);
  assert.ok(applyQuizResult({}, true).level > 50);
  assert.ok(applyQuizResult({}, false).level < 50);
});

test("薄弱词拥有更高的随机抽取权重", () => {
  assert.ok(memoryWeight({ level: 10, attempts: 3 }) > memoryWeight({ level: 90, attempts: 3 }));
  const words = [{ id: "weak" }, { id: "strong" }];
  assert.equal(pickWeightedWord(words, { weak: { level: 10 }, strong: { level: 90 } }, () => 0).id, "weak");
});
