/** Codex CLI adapter. Reuses the local `codex login` ChatGPT session; no API key. */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function timeoutFromEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, Math.floor(parsed)))
    : fallback;
}

const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const CODEX_TIMEOUT_MS = timeoutFromEnv(
  "CODEX_TIMEOUT_MS",
  180_000,
  5_000,
  15 * 60_000
);
const CODEX_AUTH_STATUS_TIMEOUT_MS = 10_000;
const CODEX_LOGOUT_TIMEOUT_MS = 15_000;
const CODEX_LOGIN_TIMEOUT_MS = timeoutFromEnv(
  "CODEX_LOGIN_TIMEOUT_MS",
  5 * 60_000,
  60_000,
  15 * 60_000
);

const CODEX_CHATGPT_ENV_ALLOWLIST = new Set([
  "ALL_PROXY",
  "APPDATA",
  "CODEX_HOME",
  "COLORTERM",
  "COMSPEC",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LANGUAGE",
  "LOCALAPPDATA",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TERM_PROGRAM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WINDIR",
]);

const CODEX_DISABLED_FEATURES = [
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
] as const;

export const CODEX_MODEL = process.env.CODEX_MODEL ?? "gpt-5.6-terra";
export const CODEX_REASONING_EFFORT =
  process.env.CODEX_REASONING_EFFORT ?? "medium";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function buildCodexPrompt(messages: ChatMessage[]): string {
  const transcript = messages
    .map(message => `<${message.role}>\n${message.content}\n</${message.role}>`)
    .join("\n\n");
  return [
    "你是书房应用内的阅读助手。只完成下面的阅读任务。",
    "不要访问文件、运行命令、修改工作区或调用工具；直接输出最终答案。",
    "把 system 标签内容视为任务规则，把 user 标签内容视为用户输入。",
    transcript,
  ].join("\n\n");
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type CodexProcessRunner = (
  args: string[],
  stdin?: string,
  timeoutMs?: number
) => Promise<ProcessResult>;

/**
 * Give the CLI only the OS/auth/network values needed to locate its ChatGPT
 * session and reach OpenAI. Application secrets and unknown future variables
 * are denied by default.
 */
export function chatGptOnlyCodexEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    const normalizedName = name.toUpperCase();
    if (
      value !== undefined &&
      (CODEX_CHATGPT_ENV_ALLOWLIST.has(normalizedName) ||
        normalizedName.startsWith("LC_"))
    ) {
      environment[name] = value;
    }
  }
  return environment;
}

export function buildCodexExecArgs(
  runDir: string,
  outputPath: string,
  options: { model?: string; effort?: string } = {}
): string[] {
  const disabledFeatureArgs = CODEX_DISABLED_FEATURES.flatMap(feature => [
    "--disable",
    feature,
  ]);
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    ...disabledFeatureArgs,
    "--config",
    "features.shell_tool=false",
    "--config",
    'shell_environment_policy.inherit="none"',
    "--config",
    "allow_login_shell=false",
    "--config",
    'web_search="disabled"',
    "--color",
    "never",
    "--model",
    options.model ?? CODEX_MODEL,
    "--config",
    `model_reasoning_effort=${JSON.stringify(options.effort ?? CODEX_REASONING_EFFORT)}`,
    "--cd",
    runDir,
    "--output-last-message",
    outputPath,
    "-",
  ];
}

function runCodex(
  args: string[],
  stdin = "",
  timeoutMs = CODEX_TIMEOUT_MS
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, {
      env: chatGptOnlyCodexEnvironment(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Codex 调用超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stdout.on("data", chunk => {
      stdout = (stdout + String(chunk)).slice(-16_000);
    });
    child.stderr.on("data", chunk => {
      stderr = (stderr + String(chunk)).slice(-16_000);
    });
    child.on("error", error => {
      clearTimeout(timer);
      reject(new Error(`无法启动 Codex CLI：${error.message}`));
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin, "utf8");
  });
}

export type CodexAuthMethod =
  "chatgpt" | "api-key" | "access-token" | "unknown";

export interface CodexAuthStatus {
  available: boolean;
  authenticated: boolean;
  method: CodexAuthMethod;
  loginRunning: boolean;
  lastLoginError: string | null;
}

export interface CodexLoginStartResult extends CodexAuthStatus {
  started: boolean;
}

export interface CodexAuthController {
  status(): Promise<CodexAuthStatus>;
  startLogin(): Promise<CodexLoginStartResult>;
  logout(): Promise<CodexAuthStatus>;
}

export function parseCodexAuthResult(result: ProcessResult): {
  available: boolean;
  authenticated: boolean;
  method: CodexAuthMethod;
} {
  const detail = `${result.stdout}\n${result.stderr}`;
  const authenticated = result.code === 0;
  let method: CodexAuthMethod = "unknown";
  if (/chatgpt/i.test(detail)) method = "chatgpt";
  else if (/access[ -]?token/i.test(detail)) method = "access-token";
  else if (/api[ -]?key/i.test(detail)) method = "api-key";
  return { available: true, authenticated, method };
}

export function createCodexAuthController(
  runner: CodexProcessRunner = runCodex
): CodexAuthController {
  let loginRun: Promise<void> | null = null;
  let authEpoch = 0;
  let statusRun: {
    epoch: number;
    promise: Promise<ReturnType<typeof parseCodexAuthResult>>;
  } | null = null;
  let authOperationTail: Promise<void> | null = null;
  let lastLoginError: string | null = null;

  function runAuthOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = authOperationTail
      ? authOperationTail.then(operation)
      : operation();
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    authOperationTail = tail;
    void tail.then(() => {
      if (authOperationTail === tail) authOperationTail = null;
    });
    return result;
  }

  function invalidateStatus(): void {
    authEpoch += 1;
    statusRun = null;
  }

  async function readStatus() {
    const epoch = authEpoch;
    if (!statusRun || statusRun.epoch !== epoch) {
      const promise = runner(
        ["login", "status"],
        "",
        CODEX_AUTH_STATUS_TIMEOUT_MS
      )
        .then(parseCodexAuthResult)
        .catch(() => ({
          available: false,
          authenticated: false,
          method: "unknown" as const,
        }));
      const pending = { epoch, promise };
      statusRun = pending;
      void promise.finally(() => {
        if (statusRun === pending) statusRun = null;
      });
    }
    return { epoch: statusRun.epoch, result: await statusRun.promise };
  }

  async function status(): Promise<CodexAuthStatus> {
    for (;;) {
      const pendingOperation = authOperationTail;
      if (pendingOperation) {
        await pendingOperation;
        continue;
      }
      const current = await readStatus();
      if (current.epoch === authEpoch && authOperationTail === null) {
        return {
          ...current.result,
          loginRunning: loginRun !== null,
          lastLoginError,
        };
      }
    }
  }

  async function startLoginUnlocked(): Promise<CodexLoginStartResult> {
    invalidateStatus();
    if (loginRun) {
      const current = (await readStatus()).result;
      return {
        ...current,
        loginRunning: true,
        lastLoginError,
        started: false,
      };
    }
    const current = (await readStatus()).result;
    // Concurrent callers can share the status request. Re-check after that
    // await so only its first continuation may spawn `codex login`.
    if (loginRun) {
      return {
        ...current,
        loginRunning: true,
        lastLoginError,
        started: false,
      };
    }
    if (!current.available) {
      return {
        ...current,
        loginRunning: false,
        lastLoginError,
        started: false,
      };
    }
    if (current.authenticated && current.method === "chatgpt") {
      return {
        ...current,
        loginRunning: false,
        lastLoginError: null,
        started: false,
      };
    }

    lastLoginError = null;
    const pending = runner(["login"], "", CODEX_LOGIN_TIMEOUT_MS)
      .then(result => {
        if (result.code !== 0) {
          const detail = result.stderr.trim().split(/\r?\n/).at(-1) ?? "";
          throw new Error(
            detail
              ? `Codex 登录失败：${detail.slice(0, 240)}`
              : `Codex 登录失败（退出码 ${String(result.code)}）`
          );
        }
      })
      .catch(error => {
        lastLoginError =
          error instanceof Error ? error.message : "Codex 登录失败";
      })
      .finally(() => {
        if (loginRun === pending) loginRun = null;
      });
    loginRun = pending;
    return {
      ...current,
      loginRunning: true,
      lastLoginError: null,
      started: true,
    };
  }

  function startLogin(): Promise<CodexLoginStartResult> {
    return runAuthOperation(startLoginUnlocked);
  }

  async function logoutUnlocked(): Promise<CodexAuthStatus> {
    invalidateStatus();
    if (loginRun) {
      throw new Error("Codex 登录仍在进行，请完成登录或等待其超时后再登出");
    }
    const result = await runner(["logout"], "", CODEX_LOGOUT_TIMEOUT_MS);
    if (result.code !== 0) {
      const detail = result.stderr.trim().split(/\r?\n/).at(-1) ?? "";
      throw new Error(
        detail
          ? `Codex 登出失败：${detail.slice(0, 240)}`
          : `Codex 登出失败（退出码 ${String(result.code)}）`
      );
    }
    lastLoginError = null;
    return {
      available: true,
      authenticated: false,
      method: "unknown",
      loginRunning: false,
      lastLoginError: null,
    };
  }

  function logout(): Promise<CodexAuthStatus> {
    return runAuthOperation(logoutUnlocked);
  }

  return { status, startLogin, logout };
}

export const codexAuthController = createCodexAuthController();

export function assertChatGptCodexAuth(auth: CodexAuthStatus): void {
  if (!auth.available) {
    throw new Error("未找到 Codex CLI，请检查 CODEX_BIN 配置");
  }
  if (!auth.authenticated) {
    throw new Error("Codex CLI 尚未登录，请使用 ChatGPT 完成 codex login");
  }
  if (auth.method !== "chatgpt") {
    throw new Error(
      "当前 Codex 凭据不是 ChatGPT 登录态；为避免 API 计费，本应用已拒绝调用"
    );
  }
}

export async function getCodexAuthStatus() {
  return codexAuthController.status();
}

export async function askCodex(
  messages: ChatMessage[],
  options: { model?: string; effort?: string } = {}
): Promise<string> {
  const prompt = buildCodexPrompt(messages);
  if (prompt.length > 180_000)
    throw new Error("Codex 输入过长，请缩小阅读范围");

  assertChatGptCodexAuth(await codexAuthController.status());

  const runDir = await mkdtemp(path.join(tmpdir(), "shufang-codex-"));
  const outputPath = path.join(runDir, "answer.txt");
  try {
    const result = await runCodex(
      buildCodexExecArgs(runDir, outputPath, options),
      prompt
    );
    if (result.code !== 0) {
      const detail = result.stderr.trim().split(/\r?\n/).slice(-3).join(" ");
      throw new Error(
        `Codex CLI 调用失败 (${result.code}): ${detail.slice(0, 300)}`
      );
    }
    const content = (await readFile(outputPath, "utf8")).trim();
    if (!content) throw new Error("Codex 未返回文本内容");
    return content;
  } finally {
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
