import { useCallback, useEffect, useRef, useState } from "react";
import {
  APP_AUTH_REQUIRED_EVENT,
  scheduleSessionExpiryRefresh,
} from "./auth-events";

export interface AppSession {
  configured: boolean;
  authenticated: boolean;
  user: { id: string } | null;
  expiresAt: number | null;
}

interface AuthErrorBody {
  error?: string;
  message?: string;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as AuthErrorBody & T;
  if (!response.ok) {
    throw new Error(body.message || `认证服务返回 ${response.status}`);
  }
  return body;
}

export interface SessionRefreshFlight {
  readonly generation: number;
  readonly promise: Promise<AppSession>;
}

/**
 * Coordinates background session reads with explicit login/logout mutations.
 * Correctness comes from the generation fence; aborting requests is optional.
 */
export function createSessionRequestCoordinator() {
  let generation = 0;
  let refreshFlight: SessionRefreshFlight | null = null;
  let mutationGeneration: number | null = null;

  return {
    refresh(load: () => Promise<AppSession>): SessionRefreshFlight {
      if (refreshFlight?.generation === generation) return refreshFlight;
      refreshFlight = { generation, promise: load() };
      return refreshFlight;
    },
    canCommitRefresh(flight: SessionRefreshFlight): boolean {
      return (
        flight.generation === generation &&
        mutationGeneration !== flight.generation
      );
    },
    finishRefresh(flight: SessionRefreshFlight): void {
      if (refreshFlight === flight) refreshFlight = null;
    },
    beginMutation(): number {
      generation += 1;
      refreshFlight = null;
      mutationGeneration = generation;
      return generation;
    },
    completeMutation(ticket: number): boolean {
      if (generation !== ticket || mutationGeneration !== ticket) return false;
      mutationGeneration = null;
      generation += 1;
      refreshFlight = null;
      return true;
    },
    failMutation(ticket: number): boolean {
      if (generation !== ticket || mutationGeneration !== ticket) return false;
      mutationGeneration = null;
      return true;
    },
    invalidate(): void {
      generation += 1;
      refreshFlight = null;
      mutationGeneration = null;
    },
  };
}

export function useAppSession() {
  const [session, setSession] = useState<AppSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const coordinator = useRef<ReturnType<
    typeof createSessionRequestCoordinator
  > | null>(null);
  if (!coordinator.current) {
    coordinator.current = createSessionRequestCoordinator();
  }

  const refresh = useCallback(async (showLoading = true) => {
    const requests = coordinator.current!;
    const flight = requests.refresh(async () => {
      const response = await fetch("/api/auth/session", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      return readJson<AppSession>(response);
    });
    if (requests.canCommitRefresh(flight)) {
      if (showLoading) setLoading(true);
      setError("");
    }
    try {
      const nextSession = await flight.promise;
      if (requests.canCommitRefresh(flight)) setSession(nextSession);
    } catch (reason) {
      if (requests.canCommitRefresh(flight)) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      requests.finishRefresh(flight);
      if (requests.canCommitRefresh(flight)) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const requests = coordinator.current!;
    return () => requests.invalidate();
  }, [refresh]);

  useEffect(
    () =>
      scheduleSessionExpiryRefresh(session, () => {
        void refresh(false);
      }),
    [refresh, session]
  );

  useEffect(() => {
    const verify = () => void refresh(false);
    const verifyWhenVisible = () => {
      if (document.visibilityState === "visible") verify();
    };
    window.addEventListener("focus", verify);
    window.addEventListener(APP_AUTH_REQUIRED_EVENT, verify);
    document.addEventListener("visibilitychange", verifyWhenVisible);
    return () => {
      window.removeEventListener("focus", verify);
      window.removeEventListener(APP_AUTH_REQUIRED_EVENT, verify);
      document.removeEventListener("visibilitychange", verifyWhenVisible);
    };
  }, [refresh]);

  const login = useCallback(async (appId: string, appSecret: string) => {
    const requests = coordinator.current!;
    const ticket = requests.beginMutation();
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, appSecret }),
      });
      const result = await readJson<{
        ok: true;
        user: { id: string };
        expiresAt: number;
      }>(response);
      if (requests.completeMutation(ticket)) {
        setSession({
          configured: true,
          authenticated: true,
          user: result.user,
          expiresAt: result.expiresAt,
        });
        setError("");
        setLoading(false);
      }
    } catch (reason) {
      if (requests.failMutation(ticket)) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      }
      throw reason;
    }
  }, []);

  const logout = useCallback(async () => {
    const requests = coordinator.current!;
    const ticket = requests.beginMutation();
    setError("");
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await readJson<{ ok: true }>(response);
      if (requests.completeMutation(ticket)) {
        setSession(current => ({
          configured: current?.configured ?? true,
          authenticated: false,
          user: null,
          expiresAt: null,
        }));
        setLoading(false);
      }
    } catch (reason) {
      if (requests.failMutation(ticket)) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      }
      throw reason;
    }
  }, []);

  return { session, loading, error, login, logout, refresh };
}
