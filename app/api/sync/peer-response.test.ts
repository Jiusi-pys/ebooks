import { expect, it } from "vitest";
import { readPeerBytes, readPeerJson } from "./peer-response";

it("bounds streamed responses even without a truthful content length", async () => {
  let canceled = false;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(9));
      },
      cancel() {
        canceled = true;
      },
    }),
    { headers: { "Content-Length": "1" } }
  );
  await expect(readPeerBytes(response, 16)).rejects.toThrow(
    "oversized_peer_response"
  );
  expect(canceled).toBe(true);
});

it("rejects oversized declared lengths and invalid UTF-8, preserving UTF-16 JSON escapes", async () => {
  await expect(
    readPeerBytes(
      new Response("{}", { headers: { "Content-Length": "99" } }),
      16
    )
  ).rejects.toThrow("oversized_peer_response");
  await expect(
    readPeerJson(new Response(new Uint8Array([0xff])))
  ).rejects.toThrow();
  expect(await readPeerJson(new Response('{"content":"\\ud800"}'))).toEqual({
    content: "\ud800",
  });
});
