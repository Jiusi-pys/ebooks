import { describe, expect, it } from "vitest";
import { searchUrl } from "./searchEngine";

describe("search engine URLs", () => {
  it("uses the selected engine and safely encodes selected text", () => {
    expect(searchUrl("google", "庄子 逍遥游")).toBe(
      "https://www.google.com/search?q=%E5%BA%84%E5%AD%90%20%E9%80%8D%E9%81%A5%E6%B8%B8"
    );
    expect(searchUrl("bing", "A&B")).toBe(
      "https://www.bing.com/search?q=A%26B"
    );
  });
});
