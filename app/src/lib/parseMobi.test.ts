import { describe, expect, it } from "vitest";
import { validateMobiBytes } from "./parseMobi";

const RECORD_OFFSET = 96;
const TEXT_RECORD_OFFSET = RECORD_OFFSET + 248;

function mobiEnvelope(options?: {
  compression?: number;
  encryption?: number;
  text?: Uint8Array;
  declaredLength?: number;
  recordSize?: number;
}): Uint8Array {
  const text = options?.text ?? new TextEncoder().encode("abc");
  const bytes = new Uint8Array(TEXT_RECORD_OFFSET + text.byteLength);
  bytes.set(new TextEncoder().encode("BOOKMOBI"), 60);
  const view = new DataView(bytes.buffer);
  view.setUint16(76, 2, false);
  view.setUint32(78, RECORD_OFFSET, false);
  view.setUint32(86, TEXT_RECORD_OFFSET, false);
  view.setUint16(RECORD_OFFSET, options?.compression ?? 1, false);
  view.setUint32(
    RECORD_OFFSET + 4,
    options?.declaredLength ?? text.byteLength,
    false
  );
  view.setUint16(RECORD_OFFSET + 8, 1, false);
  view.setUint16(RECORD_OFFSET + 10, options?.recordSize ?? 4096, false);
  view.setUint16(RECORD_OFFSET + 12, options?.encryption ?? 0, false);
  bytes.set(new TextEncoder().encode("MOBI"), RECORD_OFFSET + 16);
  view.setUint32(RECORD_OFFSET + 20, 116, false);
  view.setUint32(RECORD_OFFSET + 36, 6, false);
  bytes.set(text, TEXT_RECORD_OFFSET);
  return bytes;
}

describe("validateMobiBytes", () => {
  it("accepts an unencrypted BOOKMOBI envelope", () => {
    expect(() => validateMobiBytes(mobiEnvelope())).not.toThrow();
  });

  it("accepts EXTH 121 UINT32_MAX as the no-KF8 sentinel", () => {
    const bytes = mobiEnvelope();
    const view = new DataView(bytes.buffer);
    view.setUint32(RECORD_OFFSET + 128, 0x40, false);
    const exthOffset = RECORD_OFFSET + 16 + 116;
    bytes.set(new TextEncoder().encode("EXTH"), exthOffset);
    view.setUint32(exthOffset + 4, 24, false);
    view.setUint32(exthOffset + 8, 1, false);
    view.setUint32(exthOffset + 12, 121, false);
    view.setUint32(exthOffset + 16, 12, false);
    view.setUint32(exthOffset + 20, 0xffffffff, false);

    expect(() => validateMobiBytes(bytes)).not.toThrow();
  });

  it("rejects a file without the BOOKMOBI signature", () => {
    const bytes = mobiEnvelope();
    bytes[60] = 0;
    expect(() => validateMobiBytes(bytes)).toThrow("不是有效的 MOBI/AZW3 文件");
  });

  it("rejects PalmDOC encryption and DRM", () => {
    expect(() => validateMobiBytes(mobiEnvelope({ encryption: 2 }))).toThrow(
      "DRM 或加密"
    );
  });

  it("rejects a damaged first-record offset", () => {
    const bytes = mobiEnvelope();
    new DataView(bytes.buffer).setUint32(78, bytes.length - 4, false);
    expect(() => validateMobiBytes(bytes)).toThrow("记录表已损坏");
  });

  it("rejects a non-monotonic PalmDB record table", () => {
    const bytes = mobiEnvelope();
    new DataView(bytes.buffer).setUint32(86, RECORD_OFFSET, false);
    expect(() => validateMobiBytes(bytes)).toThrow("记录表已损坏");
  });

  it("rejects a text-record count beyond the PalmDB table", () => {
    const bytes = mobiEnvelope();
    new DataView(bytes.buffer).setUint16(RECORD_OFFSET + 8, 2, false);
    expect(() => validateMobiBytes(bytes)).toThrow("记录表已损坏");
  });

  it("rejects a declared decompressed body above the import budget", () => {
    const bytes = mobiEnvelope({
      declaredLength: 24_000_001,
      recordSize: 0xffff,
    });
    expect(() => validateMobiBytes(bytes)).toThrow("超过 2400 万字节");
  });

  it("rejects malformed PalmDOC back-references before parser startup", () => {
    const bytes = mobiEnvelope({
      compression: 2,
      text: new Uint8Array([0x80, 0]),
      declaredLength: 3,
    });
    expect(() => validateMobiBytes(bytes)).toThrow("正文压缩数据已损坏");
  });

  it("rejects a record whose decompressed body exceeds its declared record size", () => {
    const bytes = mobiEnvelope({
      text: new TextEncoder().encode("abcd"),
      declaredLength: 3,
      recordSize: 3,
    });
    expect(() => validateMobiBytes(bytes)).toThrow("正文压缩数据已损坏");
  });

  it("caps EXTH metadata entries before iterating over attacker-controlled data", () => {
    const exthCount = 1_025;
    const exthLength = 12 + exthCount * 8;
    const textOffset = RECORD_OFFSET + 16 + 116 + exthLength;
    const bytes = new Uint8Array(textOffset + 1);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode("BOOKMOBI"), 60);
    view.setUint16(76, 2, false);
    view.setUint32(78, RECORD_OFFSET, false);
    view.setUint32(86, textOffset, false);
    view.setUint16(RECORD_OFFSET, 1, false);
    view.setUint32(RECORD_OFFSET + 4, 1, false);
    view.setUint16(RECORD_OFFSET + 8, 1, false);
    view.setUint16(RECORD_OFFSET + 10, 4_096, false);
    bytes.set(new TextEncoder().encode("MOBI"), RECORD_OFFSET + 16);
    view.setUint32(RECORD_OFFSET + 20, 116, false);
    view.setUint32(RECORD_OFFSET + 36, 6, false);
    view.setUint32(RECORD_OFFSET + 128, 0x40, false);
    const exthOffset = RECORD_OFFSET + 16 + 116;
    bytes.set(new TextEncoder().encode("EXTH"), exthOffset);
    view.setUint32(exthOffset + 4, exthLength, false);
    view.setUint32(exthOffset + 8, exthCount, false);
    for (let index = 0; index < exthCount; index += 1) {
      view.setUint32(exthOffset + 12 + index * 8 + 4, 8, false);
    }
    bytes[textOffset] = 97;

    expect(() => validateMobiBytes(bytes)).toThrow("记录表已损坏");
  });
});
