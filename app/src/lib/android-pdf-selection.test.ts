// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { pdfSelectionPage } from "../../../platforms/android/web/pdf-selection";

describe("PDF selections retain their actual page identity", () => {
  it("resolves nested text on page two rather than the first displayed page", () => {
    document.body.innerHTML = '<div class="pdf-page" data-page="1">first</div><div class="pdf-page" data-page="2"><span>second</span></div>';
    const text = document.querySelector("span")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0); range.setEnd(text, 6);
    expect(pdfSelectionPage(range)?.dataset.page).toBe("2");
  });
  it("rejects a range spanning pages instead of assigning an incorrect single page", () => {
    document.body.innerHTML = '<div class="pdf-page" data-page="1">first</div><div class="pdf-page" data-page="2">second</div>';
    const pages = document.querySelectorAll(".pdf-page");
    const range = document.createRange();
    range.setStart(pages[0].firstChild!, 0); range.setEnd(pages[1].firstChild!, 6);
    expect(pdfSelectionPage(range)).toBeNull();
  });
});
