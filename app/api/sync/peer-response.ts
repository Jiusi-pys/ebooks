// Bound bytes before decoding or schema validation; headers alone are insufficient.
export async function readPeerBytes(response: Response, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("invalid_peer_response_limit");
  const declared = response.headers.get("Content-Length");
  if (declared && /^\d+$/.test(declared) && BigInt(declared) > BigInt(limit)) {
    await response.body?.cancel();
    throw new Error("oversized_peer_response");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new Error("oversized_peer_response");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function readPeerJson(response: Response): Promise<unknown> {
  const bytes = await readPeerBytes(response, 16 * 1024 * 1024);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
