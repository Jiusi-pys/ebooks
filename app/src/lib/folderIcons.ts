import type { ComponentType, SVGProps } from "react";
import {
  Archive,
  Bookmark,
  BriefcaseBusiness,
  Folder,
  GraduationCap,
  Heart,
  LibraryBig,
  Sparkles,
} from "lucide-react";
import type { FolderIconKey } from "@/types";

type Glyph = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

export const FOLDER_ICON_OPTIONS: ReadonlyArray<{
  id: FolderIconKey;
  label: string;
  icon: Glyph;
  color: string;
  background: string;
}> = [
  {
    id: "folder",
    label: "文件夹",
    icon: Folder,
    color: "#b45309",
    background: "linear-gradient(145deg, #fff7d6, #f4d78b)",
  },
  {
    id: "library",
    label: "藏书",
    icon: LibraryBig,
    color: "#9a3412",
    background: "linear-gradient(145deg, #ffebe0, #f3b69b)",
  },
  {
    id: "study",
    label: "学习",
    icon: GraduationCap,
    color: "#1d4ed8",
    background: "linear-gradient(145deg, #e9f2ff, #b8d2ff)",
  },
  {
    id: "archive",
    label: "归档",
    icon: Archive,
    color: "#475569",
    background: "linear-gradient(145deg, #f1f5f9, #cbd5e1)",
  },
  {
    id: "work",
    label: "工作",
    icon: BriefcaseBusiness,
    color: "#6d28d9",
    background: "linear-gradient(145deg, #f1eafe, #d1bcf7)",
  },
  {
    id: "heart",
    label: "喜爱",
    icon: Heart,
    color: "#be123c",
    background: "linear-gradient(145deg, #ffe9ef, #f8b6c5)",
  },
  {
    id: "sparkles",
    label: "灵感",
    icon: Sparkles,
    color: "#a16207",
    background: "linear-gradient(145deg, #fff8d8, #f6da72)",
  },
  {
    id: "bookmark",
    label: "收藏",
    icon: Bookmark,
    color: "#047857",
    background: "linear-gradient(145deg, #e2f9ef, #9fddc2)",
  },
];
