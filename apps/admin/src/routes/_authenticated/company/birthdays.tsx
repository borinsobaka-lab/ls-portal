import { createFileRoute } from "@tanstack/react-router";

import { BirthdaysPage } from "@/components/company/birthdays-page";
import { CompanyBirthdaysPageSkeleton } from "@/components/page-skeletons";
import { PORTAL_NAME } from "@/lib/brand";

/** «Компания» → «Дни рождения»: ближайшие 30 дней, свой день рождения. */
export const Route = createFileRoute("/_authenticated/company/birthdays")({
  head: () => ({ meta: [{ title: `Дни рождения — ${PORTAL_NAME}` }] }),
  pendingComponent: CompanyBirthdaysPageSkeleton,
  component: BirthdaysPage,
});
