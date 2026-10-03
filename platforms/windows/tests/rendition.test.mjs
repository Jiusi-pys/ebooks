import {test} from "node:test";
import assert from "node:assert/strict";
import {matchingChapter,localImage} from "../Shufang.Windows/Reader/rendition.mjs";
test("derived EPUB data cannot replace changed stored paragraphs",()=>{
  const chapter={id:"c",paragraphs:["中文😀"]};
  assert.equal(matchingChapter(chapter,{version:1,chapters:[{...chapter,paragraphs:["changed"]}]}),null);
  assert.deepEqual(matchingChapter(chapter,{version:1,chapters:[chapter]}),chapter);
  assert.equal(matchingChapter(chapter,{version:2,chapters:[chapter]}),null);
});
test("only bounded decoded local raster resources reach the image element",()=>{
  assert.equal(localImage("https://evil.test/image"),false);
  assert.equal(localImage("data:image/svg+xml;base64,PHN2Zz4="),false);
  assert.equal(localImage("data:image/png;base64,AA=="),true);
  assert.equal(localImage("data:image/png;base64,AA\" onload=evil"),false);
});
