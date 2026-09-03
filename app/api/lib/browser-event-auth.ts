const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Browser events may omit the API key only while the whole application is
 * running on the local machine. Origin equality alone is not authentication:
 * arbitrary HTTP clients can forge that header.
 */
export function isTrustedLocalBrowserEvent(
  requestUrl: string,
  origin: string | undefined
): boolean {
  if (!origin) return false;
  try {
    const request = new URL(requestUrl);
    const source = new URL(origin);
    return (
      LOOPBACK_HOSTS.has(request.hostname) &&
      source.origin === request.origin &&
      (request.protocol === "http:" || request.protocol === "https:")
    );
  } catch {
    return false;
  }
}
