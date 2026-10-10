/** Pure reading palette shared by Web and the packaged Android renderer. */
export interface SwatchColor {
  id: string;
  name: string;
  solid: string;
  soft: string;
}

export const SWATCH_COLORS: SwatchColor[] = [
  { id: "orange", name: "橙", solid: "#f54001", soft: "rgba(245,64,1,0.16)" },
  { id: "yellow", name: "黄", solid: "#c99908", soft: "rgba(255,193,60,0.35)" },
  { id: "green", name: "绿", solid: "#4f7a3a", soft: "rgba(122,168,92,0.30)" },
  { id: "blue", name: "蓝", solid: "#3a6a9e", soft: "rgba(96,148,196,0.28)" },
  {
    id: "purple",
    name: "紫",
    solid: "#7a5a9e",
    soft: "rgba(150,116,190,0.26)",
  },
];

export function swatch(id: string): SwatchColor {
  return SWATCH_COLORS.find(c => c.id === id) ?? SWATCH_COLORS[0];
}
