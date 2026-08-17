"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { api, getCurrentSession } from "@/lib/api";

export const apiStaleTime = {
  settlement: 5_000,
  actionItems: 10_000,
  overview: 30_000,
  connections: 30_000,
  organization: 5 * 60_000,
} as const;

function sessionId(): string {
  return getCurrentSession()?.id ?? "anonymous";
}

export function apiQueryKey(path: string): readonly ["api", string, string] {
  return ["api", sessionId(), path] as const;
}

export function fetchApiQuery<T>(client: QueryClient, path: string, staleTime: number): Promise<T> {
  return client.fetchQuery({
    queryKey: apiQueryKey(path),
    queryFn: () => api<T>(path),
    staleTime,
  });
}

export async function invalidateApiQueries(
  client: QueryClient,
  pathPrefixes: string[],
): Promise<void> {
  const currentSessionId = sessionId();
  await client.invalidateQueries({
    predicate: (query) => {
      const [kind, owner, path] = query.queryKey;
      return (
        kind === "api" &&
        owner === currentSessionId &&
        typeof path === "string" &&
        pathPrefixes.some((prefix) => path.startsWith(prefix))
      );
    },
  });
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
            gcTime: 10 * 60_000,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
