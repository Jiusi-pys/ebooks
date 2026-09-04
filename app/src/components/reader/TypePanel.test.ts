import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TYPE } from "@/lib/reading";
import { TypePanel } from "./TypePanel";

describe("TypePanel page-turn controls", () => {
  it("offers continuous vertical and horizontal page modes", () => {
    const html = renderToStaticMarkup(
      createElement(TypePanel, {
        value: DEFAULT_TYPE,
        onChange: vi.fn(),
        onClose: vi.fn(),
      })
    );

    expect(html).toContain("翻页方式");
    expect(html).toContain("上下连续");
    expect(html).toContain("左右翻页");
    expect(html).toContain('title="上下连续滚动，到章节边界后继续滚轮可切章"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });
});
