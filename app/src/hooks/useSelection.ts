import { useCallback, useMemo, useState } from "react";

/** 通用多选状态：selecting 开关 + 选中 id 集合 */
export function useSelection() {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = useCallback((id: string) => {
    setSelected(s => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback((ids: string[]) => {
    setSelected(s => (ids.every(id => s.has(id)) ? new Set() : new Set(ids)));
  }, []);

  const exit = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);

  const start = useCallback(() => setSelecting(true), []);

  return useMemo(
    () => ({ selecting, selected, toggle, selectAll, exit, start }),
    [selecting, selected, toggle, selectAll, exit, start]
  );
}

export type Selection = ReturnType<typeof useSelection>;
