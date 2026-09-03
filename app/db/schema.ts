import {
  mysqlTable,
  serial,
  varchar,
  text,
  timestamp,
  boolean,
  int,
} from "drizzle-orm/mysql-core";

/** 全书结构扫描结果（按内容哈希缓存，首次 AI 提问时生成，之后复用） */
export const bookDigests = mysqlTable("book_digests", {
  id: serial("id").primaryKey(),
  /** 书籍正文内容哈希（SHA-256 hex） */
  contentHash: varchar("content_hash", { length: 64 }).notNull().unique(),
  title: varchar("title", { length: 255 }).notNull(),
  author: varchar("author", { length: 255 }).notNull().default(""),
  /** 本地扫描出的结构 JSON：章节目录、字数、首尾段摘录 */
  structure: text("structure").notNull(),
  /** 模型基于结构生成的全书导读 */
  overview: text("overview"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type BookDigest = typeof bookDigests.$inferSelect;

/** WebHook 订阅：外部 AI（Hermes / OpenClaw 等）注册回调地址，数据变化时推送 */
export const webhookSubscriptions = mysqlTable("webhook_subscriptions", {
  id: serial("id").primaryKey(),
  /** 回调地址（https://…） */
  url: varchar("url", { length: 1024 }).notNull(),
  /** 用于 HMAC-SHA256 签名的密钥（请求头 X-Shufang-Signature: sha256=…） */
  secret: varchar("secret", { length: 255 }).notNull().default(""),
  /** 订阅的事件类型，JSON 数组，如 ["highlight.created","note.created"]；空数组 = 全部事件 */
  events: text("events").notNull(),
  active: boolean("active").notNull().default(true),
  /** 连续投递失败次数（>20 自动停用） */
  failCount: int("fail_count").notNull().default(0),
  description: varchar("description", { length: 255 }).notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect;
