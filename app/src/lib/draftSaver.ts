/** Acknowledges only persisted revisions; navigation can flush the latest draft. */
export function draftSaver<T>(
  save: (value: T) => Promise<unknown>,
  changed: (state: { dirty: boolean; error?: string }) => void = () => undefined
) {
  let revision = 0;
  let acknowledged = 0;
  let value: T;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  function flush(): Promise<void> {
    clearTimeout(timer);
    if (active) return active;
    active = (async () => {
      while (acknowledged < revision) {
        const current = revision;
        const draft = value;
        try {
          await save(draft);
          acknowledged = current;
          changed({ dirty: acknowledged < revision });
        } catch (error) {
          changed({
            dirty: true,
            error: error instanceof Error ? error.message : "Save failed",
          });
          throw error;
        }
      }
    })().finally(() => {
      active = undefined;
    });
    return active;
  }
  return {
    dirty: () => acknowledged < revision,
    update(next: T) {
      value = next;
      revision++;
      changed({ dirty: true });
      clearTimeout(timer);
      timer = setTimeout(() => void flush().catch(() => undefined), 700);
    },
    flush,
  };
}
