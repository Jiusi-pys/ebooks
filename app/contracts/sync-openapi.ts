import { z } from "zod";
import { operationSchema } from "./sync";

const json = (schema: unknown) => ({ "application/json": { schema } });
const paths: Record<string, Record<string, Record<string, unknown>>> = {};
const routes: [string, string, string][] = [
  ["get", "/capabilities", "Protocol, node, workspace and transfer limits"],
  [
    "post",
    "/sync/push",
    "Persist operations; retry the same IDs after a lost response",
  ],
  [
    "get",
    "/sync/changes",
    "Read commit-ordered changes using a node-scoped opaque cursor",
  ],
  ["post", "/sync/snapshots", "Create a fixed-watermark snapshot"],
  [
    "get",
    "/sync/snapshots/{id}",
    "Read a snapshot page; continue with after=next",
  ],
  ["get", "/entities", "Read entity states, field versions and tombstones"],
  [
    "get",
    "/entities/{kind}/{id}/history",
    "Read the last 100 immutable operations for one entity",
  ],
  [
    "post",
    "/entities/{kind}/{id}/restore",
    "Restore to a new entity ID; original tombstone remains",
  ],
  [
    "post",
    "/mutations",
    "Create a locally clocked operation; use operationId for retries",
  ],
  ["get", "/status", "Read local sequence and peer transfer status"],
  ["post", "/peers", "Owner: issue an inbound workspace-scoped credential"],
  ["delete", "/peers/{id}", "Owner: revoke an inbound credential"],
  ["post", "/blobs/uploads", "Create a resumable upload session"],
  ["get", "/blobs/uploads/{id}", "Read manifest and missing chunk indexes"],
  ["put", "/blobs/uploads/{id}/{index}", "Upload bytes with X-Chunk-SHA256"],
  [
    "post",
    "/blobs/uploads/{id}/commit",
    "Verify total size and SHA-256 before publishing",
  ],
  [
    "get",
    "/blobs/{hash}",
    "Download a verified original or JSON field payload",
  ],
  ["get", "/blobs/{hash}/chunks/{index}", "Download one 256 KiB chunk"],
];
for (const [method, path, summary] of routes) {
  const parameters: unknown[] = [...path.matchAll(/\{(\w+)\}/g)].map(match => ({
    name: match[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
  if (path === "/sync/changes")
    parameters.push({
      name: "cursor",
      in: "query",
      schema: { type: "string" },
    });
  if (path === "/entities" || path === "/sync/snapshots/{id}")
    parameters.push({ name: "after", in: "query", schema: { type: "string" } });
  if (path === "/entities")
    parameters.push({ name: "kind", in: "query", schema: { type: "string" } });
  if (method === "put")
    parameters.push({
      name: "X-Chunk-SHA256",
      in: "header",
      required: true,
      schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
    });
  const schema =
    path === "/sync/push"
      ? {
          type: "object",
          required: ["operations"],
          properties: {
            operations: {
              type: "array",
              maxItems: 100,
              items: { $ref: "#/components/schemas/Operation" },
            },
          },
        }
      : { type: "object" };
  (paths[path] ??= {})[method] = {
    summary,
    parameters,
    ...(["post", "put"].includes(method)
      ? {
          requestBody: {
            required: !path.endsWith("commit") && path !== "/sync/snapshots",
            content:
              method === "put"
                ? {
                    "application/octet-stream": {
                      schema: {
                        type: "string",
                        format: "binary",
                        maxLength: 262144,
                      },
                    },
                  }
                : json(schema),
          },
        }
      : {}),
    responses: {
      "200": { description: "Durable result or requested page" },
      "201": { description: "Created" },
      "400": { description: "Invalid input" },
      "401": { description: "Authentication or workspace mismatch" },
      "403": { description: "Owner access required" },
      "409": { description: "ID reuse, cursor mismatch or missing chunks" },
      "413": { description: "Payload exceeds limit" },
      "422": { description: "Checksum mismatch" },
      "503": { description: "Retry with the same operation ID" },
    },
  };
}
export const syncOpenApi = {
  openapi: "3.1.0",
  info: { title: "Shufang workspace replication", version: "2.0.0" },
  servers: [{ url: "/api/v2" }],
  security: [
    { BrowserSession: [] },
    { ApiKey: [] },
    { NodeToken: [], Workspace: [] },
  ],
  paths,
  components: {
    securitySchemes: {
      BrowserSession: { type: "apiKey", in: "cookie", name: "shufang_session" },
      ApiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
      NodeToken: { type: "http", scheme: "bearer" },
      Workspace: { type: "apiKey", in: "header", name: "X-Workspace-Id" },
    },
    schemas: { Operation: z.toJSONSchema(operationSchema) },
  },
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
Object.assign(syncOpenApi.components.schemas, {
  Receipt: {
    type: "object",
    properties: {
      operationId: { type: "string" },
      seq: { type: "string", pattern: "^[0-9]+$" },
      duplicate: { type: "boolean" },
      error: { type: "string" },
      persisted: { const: false },
    },
  },
  EntityState: {
    type: "object",
    required: ["id", "kind", "deleted", "fields"],
    properties: {
      id: { type: "string" },
      kind: { type: "string" },
      deleted: { type: "boolean" },
      fields: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            version: { type: "string" },
            value: {},
            removed: { type: "boolean" },
          },
        },
      },
    },
  },
  Manifest: {
    type: "object",
    required: ["sha256", "size", "name", "type"],
    properties: {
      sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      size: { type: "integer", minimum: 0, maximum: 268435456 },
      name: { type: "string", maxLength: 255 },
      type: { type: "string", maxLength: 128 },
    },
  },
});
function body(path: string, schema: unknown) {
  Object.assign(paths[path].post, {
    requestBody: { required: true, content: json(schema) },
  });
}
body("/mutations", {
  type: "object",
  required: ["operationId", "kind", "entityId"],
  properties: {
    operationId: { type: "string", description: "Reuse unchanged on retry" },
    kind: { type: "string" },
    entityId: { type: "string" },
    clock: { type: "string" },
    patch: { type: "object" },
    unset: { type: "array", items: { type: "string" } },
    deleted: { type: "boolean" },
  },
});
body("/entities/{kind}/{id}/restore", {
  type: "object",
  required: ["operationId", "newEntityId"],
  properties: {
    operationId: { type: "string" },
    newEntityId: {
      type: "string",
      description: "Must differ from the source ID",
    },
  },
});
body("/peers", {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
});
body("/blobs/uploads", ref("Manifest"));
Object.assign(paths["/sync/push"].post, {
  responses: {
    "200": {
      description:
        "Per-item durable receipts; entries with error and persisted=false must be repaired or retried",
      content: json({
        type: "object",
        properties: { receipts: { type: "array", items: ref("Receipt") } },
      }),
    },
    "409": { description: "Single operation ID reuse with different content" },
  },
});
Object.assign(paths["/sync/changes"].get, {
  responses: {
    "200": {
      description: "Cursor binds workspace, node and log epoch",
      content: json({
        type: "object",
        properties: {
          cursor: { type: "string" },
          hasMore: { type: "boolean" },
          operations: { type: "array", maxItems: 100, items: ref("Operation") },
        },
      }),
    },
    "409": { description: "Cursor scope or generation mismatch" },
  },
});
