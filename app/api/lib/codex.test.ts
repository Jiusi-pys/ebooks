import { describe, expect, it } from "vitest";
import {
  buildCodexPrompt,
  buildCodexExecArgs,
  chatGptOnlyCodexEnvironment,
  createCodexAuthController,
  assertChatGptCodexAuth,
  parseCodexAuthResult,
  type CodexProcessRunner,
} from "./codex";

describe("buildCodexPrompt", () => {
  it("preserves roles and disables workspace actions", () => {
    const prompt = buildCodexPrompt([
      { role: "system", content: "只输出译文" },
      { role: "user", content: "Hello" },
    ]);
    expect(prompt).toContain("不要访问文件、运行命令");
    expect(prompt).toContain("<system>\n只输出译文\n</system>");
    expect(prompt).toContain("<user>\nHello\n</user>");
  });
});

describe("Codex CLI authentication", () => {
  it("passes only OS/auth/network values needed by the ChatGPT session", () => {
    expect(
      chatGptOnlyCodexEnvironment({
        HOME: "/home/reader",
        USERPROFILE: "C:\\Users\\reader",
        CODEX_HOME: "C:\\Users\\reader\\.codex",
        PATH: "bin",
        HTTPS_PROXY: "http://proxy.example",
        SSL_CERT_FILE: "/etc/custom-ca.pem",
        LC_ALL: "zh_CN.UTF-8",
        APP_SECRET: "app-secret",
        DATABASE_URL: "mysql://secret",
        DEEPSEEK_API_KEY: "deepseek-key",
        OPENAI_API_KEY: "openai-key",
        codex_api_key: "codex-key",
        CODEX_ACCESS_TOKEN: "access-token",
        OPENAI_BASE_URL: "https://untrusted.example/v1",
        CODEX_REFRESH_TOKEN_URL_OVERRIDE:
          "https://untrusted.example/oauth/token",
      })
    ).toEqual({
      HOME: "/home/reader",
      USERPROFILE: "C:\\Users\\reader",
      CODEX_HOME: "C:\\Users\\reader\\.codex",
      PATH: "bin",
      HTTPS_PROXY: "http://proxy.example",
      SSL_CERT_FILE: "/etc/custom-ca.pem",
      LC_ALL: "zh_CN.UTF-8",
    });
  });

  it("disables command, connector, memory and external lookup capabilities", () => {
    const args = buildCodexExecArgs("C:\\run", "C:\\run\\answer.txt", {
      model: "gpt-test",
      effort: "low",
    });
    const disabled = args.flatMap((arg, index) =>
      arg === "--disable" ? [args[index + 1]] : []
    );

    expect(disabled).toEqual(
      expect.arrayContaining([
        "apps",
        "auth_elicitation",
        "browser_use",
        "computer_use",
        "hooks",
        "image_generation",
        "in_app_browser",
        "in_app_local_automation",
        "memories",
        "multi_agent",
        "plugins",
        "remote_plugin",
        "shell_tool",
        "shell_snapshot",
        "skill_search",
        "tool_suggest",
        "unified_exec",
        "view_image",
        "workspace_dependencies",
      ])
    );
    expect(args).toContain("features.shell_tool=false");
    expect(args).toContain('shell_environment_policy.inherit="none"');
    expect(args).toContain("allow_login_shell=false");
    expect(args).toContain('web_search="disabled"');
    expect(args).toContain("--strict-config");
  });

  it("recognizes the supported authentication modes", () => {
    expect(
      parseCodexAuthResult({
        code: 0,
        stdout: "Logged in using ChatGPT",
        stderr: "",
      })
    ).toMatchObject({ authenticated: true, method: "chatgpt" });
    expect(
      parseCodexAuthResult({
        code: 1,
        stdout: "Not logged in",
        stderr: "",
      })
    ).toMatchObject({ available: true, authenticated: false });
  });

  it("rejects non-ChatGPT credentials before an AI request can be billed", () => {
    const base = {
      available: true,
      authenticated: true,
      loginRunning: false,
      lastLoginError: null,
    };
    expect(() =>
      assertChatGptCodexAuth({ ...base, method: "chatgpt" })
    ).not.toThrow();
    expect(() =>
      assertChatGptCodexAuth({ ...base, method: "api-key" })
    ).toThrow(/避免 API 计费/);
    expect(() =>
      assertChatGptCodexAuth({
        ...base,
        authenticated: false,
        method: "unknown",
      })
    ).toThrow(/尚未登录/);
  });

  it("runs at most one explicit login at a time", async () => {
    let finishLogin:
      | ((result: { code: number; stdout: string; stderr: string }) => void)
      | undefined;
    const calls: string[][] = [];
    const runner: CodexProcessRunner = async args => {
      calls.push(args);
      if (args.length === 1 && args[0] === "login") {
        return new Promise(resolve => {
          finishLogin = resolve;
        });
      }
      return { code: 1, stdout: "Not logged in", stderr: "" };
    };
    const controller = createCodexAuthController(runner);

    expect(await controller.startLogin()).toMatchObject({
      started: true,
      loginRunning: true,
    });
    expect(await controller.startLogin()).toMatchObject({
      started: false,
      loginRunning: true,
    });
    expect(calls.filter(args => args.length === 1)).toHaveLength(1);

    finishLogin?.({ code: 0, stdout: "", stderr: "" });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await controller.status()).loginRunning).toBe(false);
  });

  it("serializes callers racing through the same status check", async () => {
    let finishStatus:
      | ((result: { code: number; stdout: string; stderr: string }) => void)
      | undefined;
    let finishLogin:
      | ((result: { code: number; stdout: string; stderr: string }) => void)
      | undefined;
    const calls: string[][] = [];
    let statusChecks = 0;
    const runner: CodexProcessRunner = args => {
      calls.push(args);
      if (args[0] === "login" && args[1] === "status") {
        statusChecks += 1;
        if (statusChecks > 1) {
          return Promise.resolve({
            code: 0,
            stdout: "Logged in using ChatGPT",
            stderr: "",
          });
        }
        return new Promise(resolve => {
          finishStatus = resolve;
        });
      }
      return new Promise(resolve => {
        finishLogin = resolve;
      });
    };
    const controller = createCodexAuthController(runner);

    const competingStarts = Promise.all([
      controller.startLogin(),
      controller.startLogin(),
    ]);
    expect(calls).toEqual([["login", "status"]]);
    finishStatus?.({ code: 1, stdout: "Not logged in", stderr: "" });

    const results = await competingStarts;
    expect(results.map(result => result.started).sort()).toEqual([false, true]);
    expect(calls.filter(args => args.length === 1)).toEqual([["login"]]);

    finishLogin?.({ code: 0, stdout: "", stderr: "" });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await controller.status()).loginRunning).toBe(false);
  });

  it("does not let logout overtake a login waiting for its status check", async () => {
    let finishStatus:
      | ((result: { code: number; stdout: string; stderr: string }) => void)
      | undefined;
    let finishLogin:
      | ((result: { code: number; stdout: string; stderr: string }) => void)
      | undefined;
    const calls: string[][] = [];
    const runner: CodexProcessRunner = args => {
      calls.push(args);
      if (args[0] === "login" && args[1] === "status") {
        return new Promise(resolve => {
          finishStatus = resolve;
        });
      }
      if (args.length === 1 && args[0] === "login") {
        return new Promise(resolve => {
          finishLogin = resolve;
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const controller = createCodexAuthController(runner);

    const starting = controller.startLogin();
    await Promise.resolve();
    expect(calls).toEqual([["login", "status"]]);

    const loggingOut = controller.logout();
    await Promise.resolve();
    expect(calls).toEqual([["login", "status"]]);

    finishStatus?.({ code: 1, stdout: "Not logged in", stderr: "" });
    await expect(starting).resolves.toMatchObject({
      started: true,
      loginRunning: true,
    });
    await expect(loggingOut).rejects.toThrow(/登录仍在进行/);
    expect(calls).toEqual([["login", "status"], ["login"]]);

    finishLogin?.({ code: 0, stdout: "", stderr: "" });
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it("does not reuse a status response that predates logout", async () => {
    let finishStaleStatus:
      | ((result: { code: number; stdout: string; stderr: string }) => void)
      | undefined;
    let statusChecks = 0;
    const calls: string[][] = [];
    const runner: CodexProcessRunner = args => {
      calls.push(args);
      if (args[0] === "logout") {
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      statusChecks += 1;
      if (statusChecks === 1) {
        return new Promise(resolve => {
          finishStaleStatus = resolve;
        });
      }
      return Promise.resolve({
        code: 1,
        stdout: "Not logged in",
        stderr: "",
      });
    };
    const controller = createCodexAuthController(runner);

    const staleStatus = controller.status();
    await Promise.resolve();
    await controller.logout();
    const afterLogout = controller.status();
    finishStaleStatus?.({
      code: 0,
      stdout: "Logged in using ChatGPT",
      stderr: "",
    });

    await expect(staleStatus).resolves.toMatchObject({
      authenticated: false,
    });
    await expect(afterLogout).resolves.toMatchObject({ authenticated: false });
    expect(calls[0]).toEqual(["login", "status"]);
    expect(calls[1]).toEqual(["logout"]);
    expect(
      calls.filter(args => args[0] === "login" && args[1] === "status").length
    ).toBeGreaterThanOrEqual(2);
  });

  it("uses the official logout command", async () => {
    const calls: string[][] = [];
    const runner: CodexProcessRunner = async args => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    const controller = createCodexAuthController(runner);
    await controller.logout();
    expect(calls).toEqual([["logout"]]);
  });
});
