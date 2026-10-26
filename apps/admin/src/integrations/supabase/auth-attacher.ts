import { createMiddleware } from "@tanstack/react-start";
import { supabase } from "./client";
import { activeStudioHeaders } from "@/hooks/use-active-studio";

export const attachSupabaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return next({
      sendContext: {},
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...activeStudioHeaders(),
      },
    });
  },
);
