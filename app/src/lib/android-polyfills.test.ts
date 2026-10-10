import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../../platforms/android/web/polyfills.js", import.meta.url), "utf8");
describe("older Android WebView PDF operator buffers", () => {
  it("uses the platform cryptographic generator for UUID version and variant bits", () => {
    let called = 0;
    const context = createContext({ crypto: { getRandomValues: (value: Uint8Array) => { called++; value.fill(255); return value; } }, structuredClone });
    runInContext(source, context);
    expect(runInContext("crypto.randomUUID()", context)).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(called).toBe(1);
  });
  it("does not add enumerable array methods that PDF.js rejects", () => {
    const context = createContext({ structuredClone });
    runInContext("delete Array.prototype.at; delete Array.prototype.toSorted; delete Array.prototype.toReversed", context);
    runInContext(source, context);
    expect(runInContext("Object.keys(Array.prototype).join(',')", context)).toBe("");
    expect(runInContext("[1,2,3].at(-1)", context)).toBe(3);
  });
  it("preserves bytes, zero fills and detaches the original", () => {
    const context = createContext({ structuredClone });
    runInContext("delete ArrayBuffer.prototype.transferToFixedLength", context);
    runInContext(source, context);
    expect(runInContext("(()=>{const a=new Uint8Array([1,2,3]).buffer;const b=a.transferToFixedLength(5);return JSON.stringify({bytes:Array.from(new Uint8Array(b)),old:a.byteLength})})()", context)).toBe('{"bytes":[1,2,3,0,0],"old":0}');
    expect(() => runInContext("new ArrayBuffer(1).transferToFixedLength(-1)", context)).toThrow();
  });
});
