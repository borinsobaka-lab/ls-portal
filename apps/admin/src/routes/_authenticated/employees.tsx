import { createFileRoute, redirect } from "@tanstack/react-router";

import { AccessUsersPageSkeleton } from "@/components/page-skeletons";

/**
 * Прежние «Доступы» (до 2026-10-25) — теперь «Пользователи и роли»
 * (/access, ACCESS.md). Адрес оставлен для старых ссылок и закладок.
 */
export const Route = createFileRoute("/_authenticated/employees")({
  pendingComponent: AccessUsersPageSkeleton,
  beforeLoad: () => {
    throw redirect({ to: "/access", replace: true });
  },
});
