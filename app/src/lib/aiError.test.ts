import { describe, expect, it } from "vitest";
import { friendlyAiError } from "./aiError";

describe("friendlyAiError", () => {
  it("explains missing model and rate limits instead of hiding them", () => {
    expect(
      friendlyAiError(new Error("请先在 AI 设置中选择或填写模型"))
    ).toMatch(/模型/);
    expect(
      friendlyAiError(new Error("deepseek API 调用失败 (429): quota exceeded"))
    ).toMatch(/额度|频繁/);
  });

  it("does not show provider response details or credentials", () => {
    expect(
      friendlyAiError(new Error("deepseek API 调用失败 (400): sk-secret-value"))
    ).not.toContain("sk-secret-value");
  });

  it("distinguishes access denial from a Codex login error", () => {
    expect(
      friendlyAiError(new Error("kimi API 调用失败 (403): denied"))
    ).toMatch(/权限/);
    expect(friendlyAiError(new Error("api_key_path_forbidden"))).toMatch(
      /ChatGPT 登录/
    );
  });
});
