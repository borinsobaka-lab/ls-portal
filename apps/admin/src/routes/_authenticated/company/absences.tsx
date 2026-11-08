import { createFileRoute } from "@tanstack/react-router";

import { AbsencesPage } from "@/components/company/absences-page";
import { CompanyAbsencesPageSkeleton } from "@/components/page-skeletons";
import { PORTAL_NAME } from "@/lib/brand";

/** «Компания» → «Отсутствия»: кто не на месте сейчас и скоро. */
export const Route = createFileRoute("/_authenticated/company/absences")({
  head: () => ({ meta: [{ title: `Отсутствия — ${PORTAL_NAME}` }] }),
  pendingComponent: CompanyAbsencesPageSkeleton,
  component: AbsencesPage,
});
