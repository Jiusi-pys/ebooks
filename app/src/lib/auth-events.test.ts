import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleSessionExpiryRefresh } from "./auth-events";

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduleSessionExpiryRefresh", () => {
  it("refreshes when an authenticated session reaches expiresAt", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const cancel = scheduleSessionExpiryRefresh(
      { authenticated: true, expiresAt: 5_000 },
      refresh,
      1_000
    );

    await vi.advanceTimersByTimeAsync(3_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledOnce();
    cancel();
  });

  it("does not schedule an unauthenticated session", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    scheduleSessionExpiryRefresh(
      { authenticated: false, expiresAt: 5_000 },
      refresh,
      1_000
    );

    await vi.runAllTimersAsync();
    expect(refresh).not.toHaveBeenCalled();
  });
});
