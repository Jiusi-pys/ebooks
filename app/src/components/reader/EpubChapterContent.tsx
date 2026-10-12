import { Fragment, type ReactNode } from "react";
import type { Chapter } from "@/types";
import type {
  EpubFigureChild,
  EpubLayout,
  EpubParagraphRole,
} from "@/lib/epubLayout";
import { EpubText } from "./EpubText";
import { EpubImage, type EpubTextImage } from "./EpubImage";

export interface EpubParagraphContext {
  role?: EpubParagraphRole;
  images: EpubTextImage[];
}

export function EpubChapterContent({
  chapter,
  layout,
  dismissSignal,
  renderParagraph,
}: {
  chapter: Chapter;
  layout?: EpubLayout;
  dismissSignal?: number;
  renderParagraph?: (index: number, context: EpubParagraphContext) => ReactNode;
}) {
  const items =
    layout?.chapters[chapter.id]?.items ??
    chapter.paragraphs.map((_, paraIndex) => ({
      kind: "paragraph" as const,
      paraIndex,
    }));
  const paragraph = (item: Extract<EpubFigureChild, { kind: "paragraph" }>) => {
    const context: EpubParagraphContext = {
      role: item.role,
      images: (item.inlineImages ?? []).flatMap(image => {
        const asset = layout?.assets[image.assetId];
        return asset ? [{ ...image, asset }] : [];
      }),
    };
    if (renderParagraph) return renderParagraph(item.paraIndex, context);
    return (
      <p
        data-pi={item.paraIndex}
        className={item.role ? `reader-epub-${item.role}` : undefined}
      >
        <EpubText
          text={chapter.paragraphs[item.paraIndex]}
          notes={chapter.footnotes?.filter(
            note => note.paraIndex === item.paraIndex
          )}
          images={context.images}
          dismissSignal={dismissSignal}
        />
      </p>
    );
  };
  const renderItem = (item: EpubFigureChild) => {
    if (item.kind === "paragraph") return paragraph(item);
    if (item.kind === "text")
      return (
        <p className={item.role ? `reader-epub-${item.role}` : undefined}>
          <EpubText
            text={item.text}
            notes={item.notes.map(note => ({ ...note, paraIndex: 0 }))}
            dismissSignal={dismissSignal}
          />
        </p>
      );
    const asset = layout?.assets[item.assetId];
    return asset ? <EpubImage asset={asset} alt={item.alt} /> : null;
  };
  const isCaption = (item: EpubFigureChild) =>
    item.kind !== "image" &&
    (item.role === "caption" || item.role === "credit");
  return (
    <>
      {items.map((item, index) => {
        if (item.kind !== "figure") {
          const content = renderItem(item);
          return item.kind === "image" ? (
            <figure className="reader-epub-figure" key={index}>
              {content}
            </figure>
          ) : (
            <Fragment key={index}>{content}</Fragment>
          );
        }
        // Only the existing caption suffix is grouped; body order is never changed.
        let captionStart = item.items.length;
        while (captionStart > 0 && isCaption(item.items[captionStart - 1]))
          captionStart--;
        return (
          <figure key={index} className="reader-epub-figure">
            {item.items.slice(0, captionStart).map((child, childIndex) => (
              <Fragment key={childIndex}>{renderItem(child)}</Fragment>
            ))}
            {captionStart < item.items.length && (
              <figcaption className="reader-epub-caption-group">
                {item.items.slice(captionStart).map((child, childIndex) => (
                  <Fragment key={childIndex}>{renderItem(child)}</Fragment>
                ))}
              </figcaption>
            )}
          </figure>
        );
      })}
    </>
  );
}
