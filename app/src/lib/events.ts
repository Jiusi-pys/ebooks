import { deliverMirrorEvent } from "./mirrorSync";

export const MIRROR_ERROR_EVENT = "shufang:mirror-error";

type MirrorEventDeliverer = typeof deliverMirrorEvent;

function reportDeliveryError(type: string, error: unknown): void {
  console.error("[mirror] event delivery failed", { type, error });
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(MIRROR_ERROR_EVENT, { detail: { type, error } })
    );
  }
}

/** Serialize changes to one logical entity without delaying unrelated IDs. */
export function createMirrorEventEmitter(
  deliver: MirrorEventDeliverer = deliverMirrorEvent
) {
  const entityTails = new Map<string, Promise<void>>();

  return function queuedEmitEvent(
    type: string,
    data: Record<string, unknown>
  ): Promise<void> {
    const extId = data.extId;
    const entityKey =
      typeof extId === "string" && extId ? extId : "__unscoped__";
    const prior = entityTails.get(entityKey);
    const delivery = prior
      ? prior.then(() => deliver({ type, data }))
      : deliver({ type, data });
    const settled = delivery.catch(error => {
      reportDeliveryError(type, error);
    });
    entityTails.set(entityKey, settled);
    void settled.then(() => {
      if (entityTails.get(entityKey) === settled) {
        entityTails.delete(entityKey);
      }
    });
    return delivery;
  };
}

/**
 * Browser mirror events remain non-blocking for reading interactions, but the
 * returned promise is awaitable and failures are visible to diagnostics/UI.
 */
export const emitEvent = createMirrorEventEmitter();
