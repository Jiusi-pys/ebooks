import type { Highlight } from "@/types";

/** Keep recent complete turns within the chat API's message and context limits. */
export function conversationHistory(qa: NonNullable<Highlight["aiQa"]>) {
  const turns: { role: "user" | "assistant"; content: string }[][] = [];
  let remaining = 24000;
  for (const turn of qa.slice(-10).reverse()) {
    if (!turn.q.trim() || !turn.a.trim()) continue;
    const q = turn.q.slice(0, 6000);
    const a = turn.a.slice(0, 6000);
    if (q.length + a.length > remaining) break;
    remaining -= q.length + a.length;
    turns.unshift([
      { role: "user", content: q },
      { role: "assistant", content: a },
    ]);
  }
  return turns.flat();
}
