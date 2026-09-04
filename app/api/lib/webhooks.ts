/**
 * WebHook 事件与投递。
 *
 * 事件来源有两路：
 *  - 服务端 REST API 内的写操作（外部 AI 通过 API 产生的变更）
 *  - 浏览器端阅读动作（划线 / 批注 / 问答 / 导入），前端调用 POST /api/v1/events 上报
 * 两路都汇入 fanout()，统一分发给订阅者。
 *
 * 投递：异步 fire-and-forget，不阻塞请求。请求体为 JSON，带 HMAC-SHA256 签名头：
 *   X-Shufang-Event: <事件类型>
 *   X-Shufang-Delivery: <唯一投递 id>
 *   X-Shufang-Signature: sha256=<hmac(secret, body)>（订阅设了 secret 才带）
 * 接收端可用相同 secret 校验签名，防止伪造事件。
 */
import { createHmac, randomUUID } from "node:crypto";
import { getDb } from "../queries/connection";
import { webhookSubscriptions } from "@db/schema";
import { eq, sql } from "drizzle-orm";
import { sanitizeEventForWebhook } from "./webhook-event";

export const EVENT_TYPES = [
  "book.imported",
  "book.updated",
  "book.deleted",
  "highlight.created",
  "highlight.updated",
  "highlight.deleted",
  "association.created",
  "association.updated",
  "association.deleted",
  "note.created",
  "note.updated",
  "note.deleted",
  "qa.recorded",
  "folder.created",
  "folder.deleted",
  "studyset.created",
  "studyset.updated",
  "studyset.deleted",
  "translation.created",
  "mindmap.created",
  "mindmap.updated",
  "mindmap.deleted",
  "highlight.tagged",
  "review.updated",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface ShufangEvent {
  type: EventType | string;
  /** 事件负载（资源快照或相关字段） */
  data: Record<string, unknown>;
  /** 产生方：reader（浏览器阅读端）/ api（REST 调用方） */
  source?: string;
}

export interface WebhookRow {
  id: number;
  url: string;
  secret: string;
  events: string;
  active: boolean;
  failCount: number;
}

type DeliveryOutcome = "success" | "failure";

// Preserve the order in which concurrent HTTP outcomes arrive for each
// subscription. Without this queue, a slow success-state write can overwrite a
// failure whose HTTP response arrived later but whose database write completed
// first. Each database statement remains atomic; the queue only defines their
// application order inside this process.
const outcomeQueues = new Map<number, Promise<void>>();

function persistDeliveryOutcome(
  subscriptionId: number,
  outcome: DeliveryOutcome
): Promise<void> {
  const previous = outcomeQueues.get(subscriptionId) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      if (outcome === "success") {
        // Always reset from the database's current value. The WebhookRow is a
        // fanout-time snapshot and must not decide whether this write is needed.
        await getDb()
          .update(webhookSubscriptions)
          .set({ failCount: 0 })
          .where(eq(webhookSubscriptions.id, subscriptionId));
        return;
      }

      await getDb()
        .update(webhookSubscriptions)
        .set({
          failCount: sql`${webhookSubscriptions.failCount} + 1`,
          active: sql`CASE WHEN ${webhookSubscriptions.failCount} + 1 > 20 THEN false ELSE ${webhookSubscriptions.active} END`,
        })
        .where(eq(webhookSubscriptions.id, subscriptionId));
    });

  outcomeQueues.set(subscriptionId, current);
  return current.finally(() => {
    if (outcomeQueues.get(subscriptionId) === current) {
      outcomeQueues.delete(subscriptionId);
    }
  });
}

export async function deliverWebhook(
  row: WebhookRow,
  event: ShufangEvent
): Promise<void> {
  const payload = JSON.stringify({
    id: randomUUID(),
    type: event.type,
    source: event.source ?? "api",
    timestamp: new Date().toISOString(),
    data: event.data,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Shufang-Event": event.type,
    "X-Shufang-Delivery": randomUUID(),
    "User-Agent": "Shufang-Webhook/1.0",
  };
  if (row.secret) {
    headers["X-Shufang-Signature"] =
      `sha256=${createHmac("sha256", row.secret).update(payload).digest("hex")}`;
  }
  let succeeded = false;
  try {
    const resp = await fetch(row.url, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    succeeded = true;
  } catch {
    succeeded = false;
  }

  await persistDeliveryOutcome(row.id, succeeded ? "success" : "failure");
}

/** 向所有订阅了该事件类型的活跃 WebHook 分发（不 await 完成，后台进行） */
export function fanout(event: ShufangEvent): void {
  const outboundEvent = sanitizeEventForWebhook(event);
  void (async () => {
    const rows = (await getDb()
      .select()
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.active, true))) as WebhookRow[];
    for (const row of rows) {
      let subscribed: string[] = [];
      try {
        subscribed = JSON.parse(row.events) as string[];
      } catch {
        subscribed = [];
      }
      if (subscribed.length > 0 && !subscribed.includes(outboundEvent.type))
        continue;
      void deliverWebhook(row, outboundEvent).catch(() => {});
    }
  })().catch(() => {});
}
