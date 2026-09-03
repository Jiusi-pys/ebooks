/** 把模型/网络错误转成读者可理解的提示 */
export function friendlyAiError(
  e: unknown,
  fallback = "模型服务暂时不可用，请稍后再试。"
): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("DeepSeek API Key 未配置")) {
    return "请先在 AI 伴读的后台设置中填写 DeepSeek API Key。";
  }
  if (msg.includes("api_key_path_forbidden") || msg.includes("(403)")) {
    return "当前预览环境暂未开通模型服务，站点发布后即可正常使用。";
  }
  if (msg.includes("(401)")) return "模型服务凭证失效，请重新保存版本后再试。";
  if (msg.toLowerCase().includes("fetch") || msg.includes("(500)"))
    return fallback;
  return msg.slice(0, 120) || fallback;
}
