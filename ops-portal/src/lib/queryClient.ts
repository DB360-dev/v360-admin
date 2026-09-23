import { QueryCache, QueryClient } from "@tanstack/react-query";
import { isPermanent, isSessionExpired } from "./errors";
import { supabase } from "./supabase";

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err) => {
      if (isSessionExpired(err)) void supabase.auth.signOut();
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !isPermanent(err) && count < 2,
    },
    mutations: { retry: false },
  },
});
