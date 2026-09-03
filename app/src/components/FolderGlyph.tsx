import type { FolderIconKey } from "@/types";
import { FOLDER_ICON_OPTIONS } from "@/lib/folderIcons";

export function FolderGlyph({
  icon = "folder",
  size = "md",
  className = "",
}: {
  icon?: FolderIconKey;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const option =
    FOLDER_ICON_OPTIONS.find(candidate => candidate.id === icon) ??
    FOLDER_ICON_OPTIONS[0];
  const Icon = option.icon;
  const dimensions =
    size === "sm"
      ? "h-7 w-7 rounded-[9px]"
      : size === "lg"
        ? "h-[76px] w-[76px] rounded-[22px]"
        : "h-10 w-10 rounded-[12px]";
  const iconSize = size === "sm" ? 14 : size === "lg" ? 36 : 19;

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center border border-white/55 shadow-[0_7px_18px_-10px_rgba(15,23,42,0.65),inset_0_1px_0_rgba(255,255,255,0.72)] ${dimensions} ${className}`}
      style={{ background: option.background, color: option.color }}
      title={option.label}
    >
      <Icon size={iconSize} strokeWidth={1.8} aria-hidden="true" />
    </span>
  );
}
