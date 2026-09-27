// Node 22+. Read-only unless --write is explicitly supplied.
import { randomUUID, createHash } from "node:crypto";
const base = process.env.SHUFANG_URL ?? "http://127.0.0.1:3000";
const headers = {
  Authorization: `Bearer ${process.env.SHUFANG_TOKEN ?? ""}`,
  "X-Workspace-Id": process.env.SHUFANG_WORKSPACE ?? "",
  "Content-Type": "application/json",
};
async function call(path, method = "GET", body, extraHeaders = {}) {
  const response = await fetch(`${base}/api/v2${path}`, {
    method,
    headers: { ...headers, ...extraHeaders },
    ...(body === undefined
      ? {}
      : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new Error(`${response.status}: ${await response.text()}`);
  return response.json();
}
const capabilities = await call("/capabilities");
console.log(
  "Node:",
  capabilities.nodeId,
  "Workspace:",
  capabilities.workspaceId
);
console.log("Status:", await call("/status"));
if (process.argv.includes("--write")) {
  const id = randomUUID();
  const text = "This book demonstrates the Shufang v2 API.\n";
  const bytes = Buffer.from(text);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    sha256,
    size: bytes.length,
    name: "example.txt",
    type: "text/plain",
  };
  const session = await call("/blobs/uploads", "POST", manifest);
  const status = await call(`/blobs/uploads/${session.id}`);
  for (const index of status.missing) {
    const part = bytes.subarray(
      index * capabilities.chunkSize,
      (index + 1) * capabilities.chunkSize
    );
    await call(`/blobs/uploads/${session.id}/${index}`, "PUT", part, {
      "Content-Type": "application/octet-stream",
      "X-Chunk-SHA256": createHash("sha256").update(part).digest("hex"),
    });
  }
  await call(`/blobs/uploads/${session.id}/commit`, "POST");
  const operationId = randomUUID();
  console.log(
    await call("/mutations", "POST", {
      operationId,
      kind: "books",
      entityId: id,
      patch: {
        title: "API example",
        author: "Sync lab",
        format: "txt",
        createdAt: Date.now(),
        coverTone: 0,
        chapters: [
          { id: "chapter", title: "Example", paragraphs: [text.trim()] },
        ],
        progress: { chapterId: "chapter", ratio: 0 },
      },
    })
  );
  console.log(
    await call("/mutations", "POST", {
      operationId: randomUUID(),
      kind: "sources",
      entityId: id,
      patch: { ...manifest, format: "txt" },
    })
  );
  console.log({ bookId: id, sha256 });
}
