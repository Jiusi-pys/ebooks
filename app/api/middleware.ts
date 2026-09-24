import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const createRouter = t.router;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (ctx.authStoreUnavailable) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "无法读取用户数据，请检查 MySQL 连接与迁移状态",
    });
  }
  if (!ctx.session) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "请先登录书房" });
  }
  if (ctx.session.setupRequired) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "请先完成首次账户设置",
    });
  }
  if (
    ctx.req.method !== "GET" &&
    ctx.req.method !== "HEAD" &&
    !ctx.sameOrigin
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "请求必须来自书房同源页面",
    });
  }
  return next({ ctx: { ...ctx, session: ctx.session } });
});

/** Kept as an alias so existing routers become protected without a flag day. */
export const publicQuery = protectedProcedure;
export const publicMutation = protectedProcedure;
