import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import {
  getRequestSession,
  isSameOriginRequest,
  type AppSession,
} from "./auth";

export type TrpcContext = {
  req: Request;
  resHeaders: Headers;
  session: AppSession | null;
  sameOrigin: boolean;
};

export async function createContext(
  opts: FetchCreateContextFnOptions
): Promise<TrpcContext> {
  return {
    req: opts.req,
    resHeaders: opts.resHeaders,
    session: getRequestSession(opts.req),
    sameOrigin: isSameOriginRequest(opts.req),
  };
}
