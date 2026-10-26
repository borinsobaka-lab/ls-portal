import { createFileRoute, redirect } from "@tanstack/react-router";

import { CLUBS_HIDDEN } from "@/lib/launch";
import { KB_URL } from "@/lib/nav-sections";

// Пока разделы клубов скрыты (lib/launch.ts), главная — база знаний; закрытую
// AccessGate сменит на первую открытую страницу.
export const Route = createFileRoute("/_authenticated/")({
  beforeLoad: () => {
    throw redirect({ to: CLUBS_HIDDEN ? KB_URL : "/dashboard" });
  },
});
