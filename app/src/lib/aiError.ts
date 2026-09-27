/** 把模型/网络错误转成读者可理解的提示 */
export function friendlyAiError(
  e: unknown,
  fallback = "模型服务暂时不可用，请稍后再试。"
): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (
    msg.includes("请先在 AI 设置中选择或填写模型") ||
    (msg.includes("invalid_type") && msg.includes('"model"'))
  ) {
    return "请先在 AI 设置中选择或填写模型。";
  }
  if (msg.includes("API Key 未配置")) {
    return "请先在 AI 设置中填写 API Key，或在服务端配置对应的密钥。";
  }
  if (msg.includes("api_key_path_forbidden"))
    return "Codex CLI 需要使用 ChatGPT 登录，请检查本机登录状态。";
  if (msg.includes("(403)"))
    return "模型服务拒绝访问，请检查密钥权限和模型访问权限。";
  if (msg.includes("(401)"))
    return "模型服务凭证失效，请检查 AI 设置中的密钥。";
  if (msg.includes("(429)"))
    return "模型服务请求过于频繁或额度不足，请稍后重试或检查额度。";
  if (msg.includes("(400)"))
    return "模型服务拒绝了请求，请检查模型名称与思考强度。";
  if (msg.includes("(404)"))
    return "模型不存在或当前密钥无权使用，请检查模型名称。";
  if (
    e instanceof Error &&
    (e.name === "TimeoutError" || e.name === "AbortError")
  )
    return "模型服务响应超时，请稍后重试。";
  if (msg.includes("too_big") || msg.includes("String must contain at most"))
    return "提问内容过长，请缩短问题或减少上下文后重试。";
  if (msg.toLowerCase().includes("fetch") || msg.includes("(500)"))
    return fallback;
  if (/(API 调用失败|模型列表获取失败) \(\d+\)/.test(msg)) return fallback;
  return fallback;
}
