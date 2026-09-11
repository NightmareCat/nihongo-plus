/**
 * @file fetch-json.mjs
 * @description 带超时和取消传播的 JSON 请求工具，避免外部 AI 接口无响应时长期占用任务。
 */

export async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 60_000, fetchImpl = fetch) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const response = await fetchImpl(url, { ...options, signal });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  } catch (error) {
    if (timeoutController.signal.aborted) {
      const timeoutError = new Error(`AI 服务在 ${Math.round(timeoutMs / 1000)} 秒内没有响应，请稍后重试`);
      timeoutError.statusCode = 504;
      timeoutError.code = "AI_REQUEST_TIMEOUT";
      throw timeoutError;
    }
    if (options.signal?.aborted) {
      const cancelledError = new Error("AI 请求已取消");
      cancelledError.statusCode = 499;
      cancelledError.code = "AI_REQUEST_CANCELLED";
      throw cancelledError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
