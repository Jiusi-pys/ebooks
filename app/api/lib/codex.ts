/** Codex CLI adapter. Reuses the local `codex login` ChatGPT session; no API key. */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS ?? 180_000);

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

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCodex(args: string[], stdin = ""): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Codex 调用超时（${CODEX_TIMEOUT_MS}ms）`));
    }, CODEX_TIMEOUT_MS);
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

export async function getCodexAuthStatus() {
  try {
    const result = await runCodex(["login", "status"]);
    const detail = `${result.stdout}\n${result.stderr}`.trim();
    return {
      available: result.code === 0,
      authenticated:
        result.code === 0 && /logged in using chatgpt/i.test(detail),
      method: /logged in using chatgpt/i.test(detail) ? "chatgpt" : "unknown",
    } as const;
  } catch {
    return {
      available: false,
      authenticated: false,
      method: "unknown",
    } as const;
  }
}

export async function askCodex(messages: ChatMessage[]): Promise<string> {
  const prompt = buildCodexPrompt(messages);
  if (prompt.length > 180_000)
    throw new Error("Codex 输入过长，请缩小阅读范围");

  const runDir = await mkdtemp(path.join(tmpdir(), "shufang-codex-"));
  const outputPath = path.join(runDir, "answer.txt");
  try {
    const result = await runCodex(
      [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "--model",
        CODEX_MODEL,
        "--config",
        `model_reasoning_effort=${JSON.stringify(CODEX_REASONING_EFFORT)}`,
        "--cd",
        runDir,
        "--output-last-message",
        outputPath,
        "-",
      ],
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
