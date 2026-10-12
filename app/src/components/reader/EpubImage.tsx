import type { EpubImageAsset, EpubInlineImage } from "@/lib/epubLayout";

export type EpubTextImage = EpubInlineImage & { asset: EpubImageAsset };

/** Imported raster data only; EPUB URLs and markup never reach the renderer. */
export function EpubImage({
  asset,
  alt,
  inline = false,
}: {
  asset: EpubImageAsset;
  alt: string;
  inline?: boolean;
}) {
  if (
    !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(
      asset.dataUrl
    )
  )
    return (
      <span role="img" aria-label={alt || "插图无法显示"}>
        {alt || "插图无法显示"}
      </span>
    );
  return (
    <img
      className={inline ? "reader-epub-inline-image" : "reader-epub-image"}
      src={asset.dataUrl}
      alt={alt}
      width={asset.width}
      height={asset.height}
      decoding="async"
      draggable={false}
    />
  );
}
