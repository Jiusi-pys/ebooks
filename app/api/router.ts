import { createRouter, publicQuery } from "./middleware";
import { aiRouter } from "./ai";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  ai: aiRouter,
});

export type AppRouter = typeof appRouter;
