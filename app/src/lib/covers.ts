/** 无封面书籍的确定性「布面」配色（从暖纸编辑色系派生） */
export const COVER_TONES = [
  { bg: "#8a4b2f", fg: "#f4ead8", band: "#ffc198" }, // 赭石
  { bg: "#4f5d4a", fg: "#eef0e4", band: "#e8d9a8" }, // 苔绿
  { bg: "#3f4a5a", fg: "#eae6da", band: "#f54001" }, // 黛蓝
  { bg: "#6e3b3b", fg: "#f2e6dc", band: "#ffc198" }, // 绛红
  { bg: "#7a6a4f", fg: "#f6f1e6", band: "#f54001" }, // 茶褐
  { bg: "#51445f", fg: "#efeadf", band: "#e8d9a8" }, // 紫檀
];

export function toneForTitle(title: string): number {
  let h = 0;
  for (let i = 0; i < title.length; i++)
    h = (h * 31 + title.charCodeAt(i)) >>> 0;
  return h % COVER_TONES.length;
}

export function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}
