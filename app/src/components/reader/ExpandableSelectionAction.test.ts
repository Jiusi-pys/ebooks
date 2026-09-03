import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExpandableSelectionAction } from "./ExpandableSelectionAction";

describe("ExpandableSelectionAction", () => {
  it("keeps an accessible name while hiding the visual label at rest", () => {
    const html = renderToStaticMarkup(
      createElement(ExpandableSelectionAction, {
        icon: createElement("span", { "data-testid": "icon" }),
        label: "批注",
      })
    );

    expect(html).toContain('aria-label="批注"');
    expect(html).toContain('title="批注"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("max-w-0");
    expect(html).toContain("group-hover:max-w-20");
    expect(html).toContain("group-focus:max-w-20");
  });

  it("preserves an explicit accessible label and disabled state", () => {
    const html = renderToStaticMarkup(
      createElement(ExpandableSelectionAction, {
        icon: createElement("span"),
        label: "关闭",
        "aria-label": "关闭 PDF 划选工具",
        disabled: true,
      })
    );

    expect(html).toContain('aria-label="关闭 PDF 划选工具"');
    expect(html).toContain("disabled");
  });
});
