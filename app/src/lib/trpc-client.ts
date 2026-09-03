import { QueryClient } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import superjson from "superjson";
import type { AppRouter } from "../../api/router";
import { dispatchAppAuthRequired } from "@/lib/auth-events";

export const trpc = createTRPCReact<AppRouter>();

export const queryClient = new QueryClient();

export const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        return globalThis
          .fetch(input, {
            ...(init ?? {}),
            credentials: "include",
          })
          .then(response => {
            if (response.status === 401) dispatchAppAuthRequired();
            return response;
          });
      },
    }),
  ],
});
