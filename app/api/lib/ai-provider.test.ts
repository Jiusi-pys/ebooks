import { describe, expect, it, vi } from "vitest";
import { askDeepSeek } from "./ai-provider";

describe("DeepSeek provider", () => {
  it("uses the official Chat Completions format with thinking effort", async () => {
    const requests: Array<[string | URL | Request, RequestInit | undefined]> =
      [];
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        requests.push([url, init]);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "回答" } }] }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    );
    const result = await askDeepSeek(
      [{ role: "user", content: "问题" }],
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        effort: "max",
        apiKey: "test-key",
      },
      fetchMock as typeof fetch
    );
    expect(result).toBe("回答");
    const [url, init] = requests[0];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "deepseek-v4-pro",
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      stream: false,
    });
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key"
    );
  });

  it("disables thinking without sending reasoning_effort", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.thinking).toEqual({ type: "disabled" });
        expect(body).not.toHaveProperty("reasoning_effort");
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "OK" } }] })
        );
      }
    );
    await askDeepSeek(
      [{ role: "user", content: "test" }],
      {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        effort: "none",
        apiKey: "key",
      },
      fetchMock as typeof fetch
    );
  });
});
