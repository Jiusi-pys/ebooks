import { describe, expect, it, vi } from "vitest";
import {
  createSessionRequestCoordinator,
  type AppSession,
} from "./appAuth";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const authenticated: AppSession = {
  configured: true,
  authenticated: true,
  user: { id: "reader" },
  expiresAt: 10_000,
};

const anonymous: AppSession = {
  configured: true,
  authenticated: false,
  user: null,
  expiresAt: null,
};

describe("session request generations", () => {
  it("does not let a stale authenticated refresh undo logout", async () => {
    const requests = createSessionRequestCoordinator();
    const oldResponse = deferred<AppSession>();
    const flight = requests.refresh(() => oldResponse.promise);
    let visibleSession = authenticated;
    const settleRefresh = flight.promise.then(session => {
      if (requests.canCommitRefresh(flight)) visibleSession = session;
      requests.finishRefresh(flight);
    });

    const logout = requests.beginMutation();
    expect(requests.completeMutation(logout)).toBe(true);
    visibleSession = anonymous;
    oldResponse.resolve(authenticated);
    await settleRefresh;

    expect(visibleSession).toEqual(anonymous);
  });

  it("does not let a stale anonymous refresh undo login", async () => {
    const requests = createSessionRequestCoordinator();
    const oldResponse = deferred<AppSession>();
    const flight = requests.refresh(() => oldResponse.promise);
    let visibleSession = anonymous;
    const settleRefresh = flight.promise.then(session => {
      if (requests.canCommitRefresh(flight)) visibleSession = session;
      requests.finishRefresh(flight);
    });

    const login = requests.beginMutation();
    expect(requests.completeMutation(login)).toBe(true);
    visibleSession = authenticated;
    oldResponse.resolve(anonymous);
    await settleRefresh;

    expect(visibleSession).toEqual(authenticated);
  });

  it("coalesces refresh storms and fences reads begun during a mutation", async () => {
    const requests = createSessionRequestCoordinator();
    const response = deferred<AppSession>();
    const load = vi.fn(() => response.promise);

    const first = requests.refresh(load);
    const second = requests.refresh(load);
    expect(second).toBe(first);
    expect(load).toHaveBeenCalledOnce();

    const login = requests.beginMutation();
    const duringMutation = requests.refresh(load);
    expect(requests.canCommitRefresh(duringMutation)).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
    expect(requests.completeMutation(login)).toBe(true);

    response.resolve(anonymous);
    await first.promise;
    await duringMutation.promise;
    expect(requests.canCommitRefresh(first)).toBe(false);
    expect(requests.canCommitRefresh(duringMutation)).toBe(false);
  });

  it("clears only the refresh flight that actually settled", async () => {
    const requests = createSessionRequestCoordinator();
    const oldResponse = deferred<AppSession>();
    const oldFlight = requests.refresh(() => oldResponse.promise);
    const mutation = requests.beginMutation();
    expect(requests.failMutation(mutation)).toBe(true);
    const newResponse = deferred<AppSession>();
    const loadNew = vi.fn(() => newResponse.promise);
    const newFlight = requests.refresh(loadNew);

    requests.finishRefresh(oldFlight);
    expect(requests.refresh(loadNew)).toBe(newFlight);
    expect(loadNew).toHaveBeenCalledOnce();

    oldResponse.reject(new Error("stale"));
    await expect(oldFlight.promise).rejects.toThrow("stale");
    newResponse.resolve(anonymous);
    await newFlight.promise;
  });
});
