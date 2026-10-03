import { test } from "node:test";
import assert from "node:assert/strict";
import { markedSegments, serialDispatch } from "./Shufang.Windows/Reader/anchors.mjs";

test("overlapping UTF-16 marks preserve text and selection offsets", () => {
  const text = "甲😀乙丙丁";
  const segments = markedSegments(text, [
    { start: 1, end: 4, text: "😀乙" },
    { start: 3, end: 5, text: "乙丙" },
    { start: 0, end: 1, text: "stale" },
  ]);
  assert.deepEqual(segments, [
    { text: "甲", marked: false },
    { text: "😀乙丙", marked: true },
    { text: "丁", marked: false },
  ]);
  assert.equal(segments.map(s => s.text).join(""), text);
});

test("invalid or surrogate-splitting anchors are never rendered", () => {
  assert.deepEqual(markedSegments("😀ab", [{ start: 1, end: 2, text: "\ude00" }]), [{ text: "😀ab", marked: false }]);
  assert.deepEqual(markedSegments("abc", [{ start: -1, end: 3, text: "c" }]), [{ text: "abc", marked: false }]);
});

test("jump waits for asynchronous PDF loading and recovers after errors", async () => {
  let release; const loaded = new Promise(resolve => { release = resolve; });
  const calls = []; const dispatch = serialDispatch(error => calls.push(error.message));
  const book = dispatch(async () => { await loaded; calls.push("book"); });
  const jump = dispatch(async () => { calls.push("jump"); });
  await Promise.resolve(); assert.deepEqual(calls, []);
  release(); await Promise.all([book,jump]);
  await dispatch(async () => { throw new Error("failed"); });
  await dispatch(async () => { calls.push("retry"); });
  assert.deepEqual(calls, ["book","jump","failed","retry"]);
});
