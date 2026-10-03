import { sharedCore } from "./core-runtime";
import type { BlobReference } from "./sync";

export function fieldObject(value: unknown):
  | {
      reference: BlobReference;
      bytes: Uint8Array;
    }
  | undefined {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const core = sharedCore();
  if (!core.execute<boolean>("externalFieldPolicy", { size: bytes.length }))
    return;
  const hash = hashObjectBytes(bytes);
  return {
    reference: {
      $blob: {
        sha256: hash,
        size: bytes.length,
        name: "field.json",
        type: "application/json",
      },
    },
    bytes,
  };
}
export function hashObjectBytes(bytes: Uint8Array): string {
  const core = sharedCore();
  core.execute("externalFieldPolicy", { size: bytes.length });
  const handle = core.execute<number>("fieldHashBegin", {});
  let hash: string;
  try {
    for (let offset = 0; offset < bytes.length; offset += 262144) {
      const hex = Array.from(bytes.subarray(offset, offset + 262144), b =>
        b.toString(16).padStart(2, "0")
      ).join("");
      core.execute("fieldHashAppend", { handle, hex });
    }
    hash = core.execute<string>("fieldHashFinish", { handle });
  } finally {
    core.execute("fieldHashAbort", { handle });
  }
  return hash;
}
