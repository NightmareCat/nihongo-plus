/**
 * @file fetch-json.test.mjs
 * @description 验证外部 API 请求可以按时超时，并能响应调用方的主动取消。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { fetchJsonWithTimeout } from "../src/fetch-json.mjs";

function pendingFetch(_url, { signal }) {
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

test("外部 API 长时间无响应时返回明确的超时错误", async () => {
  await assert.rejects(
    fetchJsonWithTimeout("https://example.invalid", {}, 20, pendingFetch),
    (error) => error.code === "AI_REQUEST_TIMEOUT" && error.statusCode === 504,
  );
});

test("调用方取消时立即终止外部 API 请求", async () => {
  const controller = new AbortController();
  const request = fetchJsonWithTimeout("https://example.invalid", { signal: controller.signal }, 1_000, pendingFetch);
  controller.abort();
  await assert.rejects(request, (error) => error.code === "AI_REQUEST_CANCELLED" && error.statusCode === 499);
});
