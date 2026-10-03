import { z } from "zod";
import { sharedCore } from "./core-runtime";
import { applyCoreOperation, mergeCoreStates } from "./core-fields";

export const entityKinds = [
  "books",
  "folders",
  "notes",
  "highlights",
  "associations",
  "translations",
  "mindMaps",
  "studySets",
  "reviews",
  "preferences",
  "sources",
] as const;
export const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w.:-]+$/);
export const operationSchema = z
  .object({
    workspaceId: identifier,
    operationId: identifier,
    replicaId: identifier,
    kind: z.enum(entityKinds),
    entityId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\p{L}\p{M}\p{N}_.:-]+$/u),
    clock: z.string().regex(/^\d{1,16}:\d{1,10}$/),
    patch: z.record(z.string().min(1).max(256), z.json()),
    unset: z.array(z.string().min(1).max(256)).max(256).default([]),
    deleted: z.boolean().default(false),
  })
  .strict()
  .refine(
    op =>
      [...Object.keys(op.patch), ...op.unset].every(
        k => !["id", "__proto__", "constructor", "prototype"].includes(k)
      ),
    "reserved field"
  );
export type Operation = z.infer<typeof operationSchema>;
const common = { id: z.string(), createdAt: z.number().finite() };
const readingSessionSchema = z
  .object({
    id: identifier,
    bookId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\p{L}\p{M}\p{N}_.:-]+$/u),
    startedAt: z.number().finite().min(0),
    endedAt: z.number().finite().min(0),
  })
  .strict()
  .refine(session => session.endedAt >= session.startedAt, "invalid interval");
export const projectionSchemas = {
  sources: z.object({
    id: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z
      .number()
      .int()
      .min(0)
      .max(256 * 1024 * 1024),
    name: z.string().max(255),
    type: z.string().max(128),
    format: z.string().optional(),
  }),
  notes: z.object({
    ...common,
    title: z.string(),
    content: z.string(),
    updatedAt: z.number().finite(),
  }),
  books: z.object({
    ...common,
    title: z.string(),
    author: z.string(),
    format: z.enum(["pdf", "epub", "mobi", "azw3", "fb2", "txt", "builtin"]),
    coverTone: z.number(),
    chapters: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        paragraphs: z.array(z.string()),
      })
    ),
    progress: z.object({ chapterId: z.string(), ratio: z.number() }),
    readingSessions: z.array(readingSessionSchema).optional(),
  }),
  folders: z.object({ ...common, name: z.string() }),
  highlights: z.object({
    ...common,
    bookId: z.string(),
    chapterId: z.string(),
    chapterTitle: z.string(),
    text: z.string(),
  }),
  translations: z.object({
    ...common,
    bookId: z.string(),
    chapterId: z.string(),
    targetLang: z.string(),
    text: z.string(),
    updatedAt: z.number(),
  }),
  mindMaps: z.object({
    ...common,
    title: z.string(),
    bookId: z.string(),
    root: z.object({
      id: z.string(),
      text: z.string(),
      children: z.array(z.json()),
    }),
  }),
  studySets: z.object({
    ...common,
    name: z.string(),
    bookIds: z.array(z.string()),
    updatedAt: z.number(),
  }),
  associations: z.object({
    ...common,
    source: z.object({ bookId: z.string() }),
    target: z.object({ bookId: z.string() }),
    pairKey: z.string(),
    direction: z.enum(["bidirectional", "source-to-target"]),
    updatedAt: z.number(),
  }),
};
export function projectable(
  kind: string,
  data: Record<string, unknown>
): boolean {
  const schema = projectionSchemas[kind as keyof typeof projectionSchemas];
  return !schema || schema.safeParse(data).success;
}
export function validatePatch(op: Operation) {
  const schema = projectionSchemas[op.kind as keyof typeof projectionSchemas];
  if (schema)
    schema
      .partial()
      .passthrough()
      .parse(
        Object.fromEntries(
          Object.entries(op.patch).filter(([, v]) => !isBlobReference(v))
        )
      );
}
export interface BlobReference {
  $blob: { sha256: string; size: number; name: string; type: string };
}
export function isBlobReference(value: unknown): value is BlobReference {
  if (!value || typeof value !== "object" || !("$blob" in value)) return false;
  const ref = (value as BlobReference).$blob;
  return (
    !!ref &&
    /^[a-f0-9]{64}$/.test(ref.sha256) &&
    Number.isInteger(ref.size) &&
    ref.size >= 0 &&
    ref.size <= 256 * 1024 * 1024
  );
}
export interface EntityState {
  id: string;
  kind: Operation["kind"];
  deleted: boolean;
  fields: Record<
    string,
    { version: string; value?: unknown; removed?: boolean }
  >;
}
export function mergeStates(
  prior: EntityState | undefined,
  incoming: EntityState
): EntityState {
  return mergeCoreStates(prior, incoming);
}

export function nextClock(previous = "0:0", now = Date.now()): string {
  return sharedCore().execute<string>("nextClock", { previous, now });
}
export function compareClock(a: string, b: string): number {
  return sharedCore().execute<number>("compareClock", { a, b });
}

export function makeOperation(
  workspaceId: string,
  replicaId: string,
  kind: Operation["kind"],
  entityId: string,
  patch: Record<string, unknown>,
  now = Date.now()
): Operation {
  return operationSchema.parse({
    workspaceId,
    replicaId,
    kind,
    entityId,
    patch: flattenFields(kind, patch),
    operationId: crypto.randomUUID(),
    clock: `${now}:0`,
  });
}
export function flattenFields(
  kind: Operation["kind"],
  value: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...value };
  if (kind === "studySets" && Array.isArray(value.bookIds)) {
    delete result.bookIds;
    for (const id of value.bookIds) result[`@member:${id}`] = true;
  }
  if (kind === "books" && Array.isArray(value.readingSessions)) {
    delete result.readingSessions;
    for (const session of value.readingSessions as {
      id: string;
      bookId: string;
      startedAt: number;
      endedAt: number;
    }[])
      result[`@readingSession:${session.id}`] = session;
  }
  if (kind === "mindMaps" && value.root && typeof value.root === "object") {
    delete result.root;
    const visit = (
      node: Record<string, unknown>,
      parent: string | null,
      order: number
    ) => {
      const id = String(node.id);
      for (const [key, item] of Object.entries(node))
        if (key !== "children" && key !== "id")
          result[`@node:${id}:${key}`] = item;
      result[`@node:${id}:parent`] = parent;
      result[`@node:${id}:order`] = order;
      if (Array.isArray(node.children))
        node.children.forEach((child, index) => visit(child, id, index));
    };
    visit(value.root as Record<string, unknown>, null, 0);
  }
  return result;
}
export function applyOperation(
  prior: EntityState | undefined,
  op: Operation
): EntityState {
  return applyCoreOperation(prior, op);
}

export function materialize(
  state: EntityState
): Record<string, unknown> | null {
  if (state.deleted) return null;
  const data = Object.fromEntries([
    ["id", state.id],
    ...Object.entries(state.fields)
      .filter(([, field]) => !field.removed)
      .map(([key, field]) => [key, field.value]),
  ]);
  if (state.kind === "books") {
    const progressByDevice: Record<string, unknown> = {};
    for (const key of Object.keys(data))
      if (key.startsWith("@progress:")) {
        progressByDevice[key.slice(10)] = data[key];
        delete data[key];
      }
    if (Object.keys(progressByDevice).length)
      data.progressByDevice = progressByDevice;
  }
  if (state.kind === "studySets") {
    data.bookIds = Object.keys(data)
      .filter(k => k.startsWith("@member:"))
      .map(k => k.slice(8))
      .sort();
    for (const key of Object.keys(data))
      if (key.startsWith("@member:")) delete data[key];
  }
  if (state.kind === "books") {
    data.readingSessions = Object.keys(data)
      .filter(key => key.startsWith("@readingSession:"))
      .map(key => data[key]);
    (data.readingSessions as { id: string }[]).sort((a, b) =>
      a.id.localeCompare(b.id)
    );
    for (const key of Object.keys(data))
      if (key.startsWith("@readingSession:")) delete data[key];
    if ((data.readingSessions as unknown[]).length === 0)
      delete data.readingSessions;
  }
  if (state.kind === "mindMaps") {
    const nodes: Record<string, Record<string, unknown>> = Object.create(null);
    for (const [key, value] of Object.entries(data)) {
      if (!key.startsWith("@node:")) continue;
      const last = key.lastIndexOf(":");
      const id = key.slice(6, last);
      const field = key.slice(last + 1);
      (nodes[id] ??= { id })[field] = value;
      delete data[key];
    }
    const roots = Object.values(nodes)
      .filter(n => n.parent === null)
      .sort((a, b) =>
        String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0
      );
    const build = (
      node: Record<string, unknown>,
      seen: Set<string>
    ): Record<string, unknown> => {
      const { parent: _parent, order: _order, ...rest } = node;
      void _parent;
      void _order;
      seen.add(String(node.id));
      return {
        ...rest,
        children: Object.values(nodes)
          .filter(n => n.parent === node.id && !seen.has(String(n.id)))
          .sort(
            (a, b) =>
              Number(a.order) - Number(b.order) ||
              (String(a.id) < String(b.id)
                ? -1
                : String(a.id) > String(b.id)
                  ? 1
                  : 0)
          )
          .map(n => build(n, new Set(seen))),
      };
    };
    if (roots.length) data.root = build(roots[0], new Set());
  }
  return data;
}
export function stableJson(value: unknown): string {
  return sharedCore().execute<string>("normalizeJson", {
    json: JSON.stringify(value),
    canonical: true,
  });
}
