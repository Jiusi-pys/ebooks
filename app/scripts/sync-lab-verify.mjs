import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const config = JSON.parse(readFileSync(".runtime/sync-lab/credentials.json"));
const urls = ["http://127.0.0.1:3101", "http://127.0.0.1:3102"];
const workspace = "windows-linux-lab";
const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  nodes: [],
  artifacts: {
    boot: createHash("sha256")
      .update(readFileSync("dist/boot.js"))
      .digest("hex"),
  },
};
const headers = {
  "X-API-Key": config.apiKey,
  "Content-Type": "application/json",
};
async function request(node, path, method = "GET", body) {
  const r = await fetch(urls[node] + "/api/v2" + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await r.json();
  if (!r.ok)
    throw new Error(`${node} ${path}: ${r.status} ${JSON.stringify(json)}`);
  return json;
}
const op = (
  kind,
  entityId,
  patch,
  replicaId = "lab-writer",
  now = Date.now()
) => ({
  workspaceId: workspace,
  operationId: randomUUID(),
  replicaId,
  clock: `${now}:0`,
  kind,
  entityId,
  patch,
  unset: [],
  deleted: false,
});
const push = (node, operation) =>
  request(node, "/sync/push", "POST", { operations: [operation] });
const canonical = value =>
  value && typeof value === "object"
    ? Array.isArray(value)
      ? value.map(canonical)
      : Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)])
        )
    : value;
async function entities(node) {
  let after = "";
  const result = [];
  do {
    const p = await request(
      node,
      `/entities?after=${encodeURIComponent(after)}`
    );
    result.push(...p.entities);
    after = p.entities.length === 100 ? p.next : "";
  } while (after);
  return result;
}
async function converge() {
  const start = Date.now();
  let latest;
  while (Date.now() - start < 15000) {
    const [a, b] = await Promise.all([entities(0), entities(1)]);
    latest = [a, b];
    if (JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)))
      return Date.now() - start;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(
    `did not converge within 15 s: ${latest.map(a => a.length).join(",")}`
  );
}
async function check(name, fn) {
  const details = await fn();
  report.checks.push({ name, passed: true, details });
  console.log(`PASS ${name}`, details ?? "");
}
try {
  report.nodes = await Promise.all([
    request(0, "/capabilities"),
    request(1, "/capabilities"),
  ]);
  await check("both directions/all entity kinds", async () => {
    const kinds = report.nodes[0].kinds;
    for (const [i, kind] of kinds.entries()) {
      if (kind === "sources") continue;
      const id = `lab-${kind}`;
      const patch = {
        title: `Lab ${kind}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      if (kind === "books")
        Object.assign(patch, {
          author: "Sync lab",
          format: "txt",
          coverTone: 0,
          chapters: [
            {
              id: "chapter-1",
              title: "Test",
              paragraphs: ["Distributed sync fixture."],
            },
          ],
          progress: { chapterId: "chapter-1", ratio: 0 },
        });
      if (kind === "notes")
        Object.assign(patch, { content: "Windows/Linux fixture" });
      if (kind === "folders") Object.assign(patch, { name: "Sync lab" });
      if (kind === "highlights")
        Object.assign(patch, {
          bookId: "lab-books",
          chapterId: "chapter-1",
          chapterTitle: "Test",
          text: "fixture",
        });
      if (kind === "translations")
        Object.assign(patch, {
          bookId: "lab-books",
          chapterId: "chapter-1",
          text: "测试",
          targetLang: "zh",
        });
      if (kind === "studySets")
        Object.assign(patch, { name: "Lab", bookIds: ["lab-books"] });
      if (kind === "mindMaps")
        Object.assign(patch, {
          bookId: "lab-books",
          root: { id: "root", text: "Lab", children: [] },
        });
      if (kind === "associations")
        Object.assign(patch, {
          source: {
            bookId: "lab-books",
            chapterId: "chapter-1",
            paraIndex: 0,
            start: 0,
            end: 4,
          },
          target: {
            bookId: "lab-books",
            chapterId: "chapter-1",
            paraIndex: 0,
            start: 5,
            end: 9,
          },
          pairKey: "lab-pair",
          direction: "bidirectional",
        });
      const operation = op(kind, id, patch);
      if (kind === "reviews") operation.entityId = operation.operationId;
      await push(i % 2, operation);
    }
    return { convergenceMs: await converge() };
  });
  await check(
    "create update delete every mutable kind from both nodes",
    async () => {
      const baseline = await entities(0);
      const ids = [];
      for (const kind of report.nodes[0].kinds.filter(k => k !== "reviews")) {
        const template = baseline.find(e => e.kind === kind && !e.deleted);
        assert(template, `missing template: ${kind}`);
        for (const node of [0, 1]) {
          const id = `crud-${kind}-${randomUUID()}`;
          const patch = Object.fromEntries(
            Object.entries(template.fields)
              .filter(([, v]) => !v.removed)
              .map(([k, v]) => [k, v.value])
          );
          await push(node, op(kind, id, patch));
          ids.push({ kind, id, node });
        }
      }
      await converge();
      for (const { kind, id, node } of ids)
        await push(
          1 - node,
          op(kind, id, { labMarker: "edited on opposite node" })
        );
      await converge();
      for (const { kind, id, node } of ids)
        await push(node, { ...op(kind, id, {}), deleted: true });
      await converge();
      const final = await entities(0);
      for (const { id, kind } of ids) {
        assert(final.find(e => e.id === id)?.deleted);
        const history = await request(1, `/entities/${kind}/${id}/history`);
        assert.equal(history.operations.length, 3);
      }
      return { entities: ids.length, histories: ids.length };
    }
  );
  await check(
    "independent mind map nodes, memberships and immutable review events",
    async () => {
      const id = randomUUID();
      const now = Date.now();
      await Promise.all([
        push(
          0,
          op(
            "mindMaps",
            id,
            {
              "@node:r:text": "Root",
              "@node:r:parent": null,
              "@node:a:text": "A",
              "@node:a:parent": "r",
              "@node:a:order": 0,
            },
            "a",
            now
          )
        ),
        push(
          1,
          op(
            "mindMaps",
            id,
            { "@node:b:text": "B", "@node:b:parent": "r", "@node:b:order": 0 },
            "b",
            now
          )
        ),
        push(0, op("studySets", id, { "@member:a": true }, "a", now)),
        push(1, op("studySets", id, { "@member:b": true }, "b", now)),
      ]);
      for (const node of [0, 1]) {
        const event = op("reviews", id, {
          highlightId: "lab-highlights",
          rating: node + 2,
          createdAt: now,
        });
        event.entityId = event.operationId;
        await push(node, event);
        assert.equal((await push(node, event)).receipts[0].duplicate, true);
      }
      await converge();
      const all = await entities(0);
      assert(
        all.find(e => e.kind === "mindMaps" && e.id === id).fields[
          "@node:b:text"
        ]
      );
      assert(
        all.find(e => e.kind === "studySets" && e.id === id).fields["@member:a"]
      );
    }
  );
  await check("concurrent field merge and deterministic winner", async () => {
    const now = Date.now();
    await Promise.all([
      push(
        0,
        op(
          "notes",
          "lab-conflict",
          { title: "Windows", content: "A" },
          "a",
          now
        )
      ),
      push(
        1,
        op("notes", "lab-conflict", { content: "B", color: "blue" }, "b", now)
      ),
    ]);
    await converge();
    const state = (await entities(0)).find(e => e.id === "lab-conflict");
    assert.equal(state.fields.title.value, "Windows");
    assert.equal(state.fields.content.value, "B");
    assert.equal(state.fields.color.value, "blue");
  });
  await check(
    "lost acknowledgement retry and duplicate payload rejection",
    async () => {
      const item = op("notes", "lab-retry", {
        title: "retry",
        content: "same",
      });
      await push(0, item);
      assert.equal((await push(0, item)).receipts[0].duplicate, true);
      const r = await fetch(urls[0] + "/api/v2/sync/push", {
        method: "POST",
        headers,
        body: JSON.stringify({
          operations: [{ ...item, patch: { title: "changed" } }],
        }),
      });
      assert.equal(r.status, 409);
    }
  );
  await check("delete wins over delayed update", async () => {
    await push(0, { ...op("notes", "lab-deleted", {}), deleted: true });
    await push(
      1,
      op("notes", "lab-deleted", { content: "late" }, "late", Date.now() + 5000)
    );
    await converge();
    assert.equal(
      (await entities(0)).find(e => e.id === "lab-deleted").deleted,
      true
    );
  });
  await check("snapshot watermark preserves concurrent mutations", async () => {
    const snapshot = await request(0, "/sync/snapshots", "POST");
    const item = op("notes", `snapshot-${randomUUID()}`, { content: "after" });
    await push(0, item);
    const page = await request(
      0,
      `/sync/changes?cursor=${encodeURIComponent(snapshot.cursor)}`
    );
    assert(page.operations.some(o => o.operationId === item.operationId));
  });
  await check("authentication, workspace scope and revocation", async () => {
    assert.equal(
      (
        await fetch(urls[0] + "/api/v2/entities", {
          headers: { Authorization: "Bearer invalid" },
        })
      ).status,
      401
    );
    const pair = await request(0, "/peers", "POST", { id: "temporary-test" });
    const auth = {
      Authorization: `Bearer ${pair.token}`,
      "X-Workspace-Id": workspace,
    };
    assert.equal(
      (
        await fetch(urls[0] + "/api/v2/entities", {
          headers: { ...auth, "X-Workspace-Id": "wrong" },
        })
      ).status,
      401
    );
    await request(0, "/peers/temporary-test", "DELETE");
    assert.equal(
      (await fetch(urls[0] + "/api/v2/entities", { headers: auth })).status,
      401
    );
  });
  await check(
    "resumable file upload, corrupt chunk rejection and remote checksum",
    async () => {
      const bytes = Buffer.from(
        "Windows Linux original file fixture.\n".repeat(18000) + randomUUID()
      );
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const manifest = {
        sha256,
        size: bytes.length,
        name: "lab.txt",
        type: "text/plain",
        format: "txt",
      };
      const upload = await request(0, "/blobs/uploads", "POST", manifest);
      const bad = await fetch(
        urls[0] + `/api/v2/blobs/uploads/${upload.id}/0`,
        {
          method: "PUT",
          headers: { ...headers, "X-Chunk-SHA256": "0".repeat(64) },
          body: bytes.subarray(0, 262144),
        }
      );
      assert.equal(bad.status, 422);
      for (let i = 0; i < upload.chunks; i++) {
        if (i === 1) continue;
        const part = bytes.subarray(i * 262144, (i + 1) * 262144);
        const r = await fetch(
          urls[0] + `/api/v2/blobs/uploads/${upload.id}/${i}`,
          {
            method: "PUT",
            headers: {
              ...headers,
              "Content-Type": "application/octet-stream",
              "X-Chunk-SHA256": createHash("sha256").update(part).digest("hex"),
            },
            body: part,
          }
        );
        assert(r.ok);
      }
      assert.deepEqual(
        (await request(0, `/blobs/uploads/${upload.id}`)).missing,
        [1]
      );
      const missing = await fetch(
        urls[0] + `/api/v2/blobs/uploads/${upload.id}/commit`,
        { method: "POST", headers }
      );
      assert.equal(missing.status, 409);
      const part = bytes.subarray(262144, 524288);
      await fetch(urls[0] + `/api/v2/blobs/uploads/${upload.id}/1`, {
        method: "PUT",
        headers: {
          ...headers,
          "X-Chunk-SHA256": createHash("sha256").update(part).digest("hex"),
        },
        body: part,
      });
      await request(0, `/blobs/uploads/${upload.id}/commit`, "POST");
      await push(0, op("sources", "lab-books", manifest));
      for (let n = 0; n < 30; n++) {
        const r = await fetch(urls[1] + `/api/v2/blobs/${sha256}`, { headers });
        if (r.ok) {
          assert.equal(
            createHash("sha256")
              .update(Buffer.from(await r.arrayBuffer()))
              .digest("hex"),
            sha256
          );
          return { sha256, size: bytes.length };
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error("remote file not available within 15 s");
    }
  );
  report.finishedAt = new Date().toISOString();
} catch (error) {
  report.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  writeFileSync(
    ".runtime/sync-lab/api-report.json",
    JSON.stringify(report, null, 2)
  );
}
