export const APP_AUTH_REQUIRED_EVENT = "shufang:auth-required";

/** Ask the session owner to re-read its HttpOnly cookie state. */
export function dispatchAppAuthRequired(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(APP_AUTH_REQUIRED_EVENT));
  }
}

export function scheduleSessionExpiryRefresh(
  session: { authenticated: boolean; expiresAt: number | null } | null,
  refresh: () => void,
  nowMs = Date.now()
): () => void {
  if (
    !session?.authenticated ||
    session.expiresAt === null ||
    !Number.isFinite(session.expiresAt)
  ) {
    return () => undefined;
  }
  const timer = globalThis.setTimeout(
    refresh,
    Math.max(0, session.expiresAt - nowMs)
  );
  return () => globalThis.clearTimeout(timer);
}
