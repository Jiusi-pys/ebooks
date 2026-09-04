import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import {
  isSameOriginRequest,
  validateRequestSession,
  type AppSession,
} from "./auth";

export type TrpcContext = {
  req: Request;
  resHeaders: Headers;
  session: AppSession | null;
  authStoreUnavailable: boolean;
  sameOrigin: boolean;
};

export async function createContext(
  opts: FetchCreateContextFnOptions
): Promise<TrpcContext> {
  const validation = await validateRequestSession(opts.req);
  return {
    req: opts.req,
    resHeaders: opts.resHeaders,
    session: validation.ok ? validation.session : null,
    authStoreUnavailable: !validation.ok && validation.status === 503,
    sameOrigin: isSameOriginRequest(opts.req),
  };
}
