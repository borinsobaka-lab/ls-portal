import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { AnalyticsHomeBody, AnalyticsHomePageSkeleton } from "@/components/page-skeletons";
import { InfoNote } from "@/components/ui/form-field";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { anCan } from "@/lib/analytics/access";
import {
  AN_CARDS,
  AN_HOME_TEXT,
  AN_MYCITY_CARD,
  AN_TITLES,
  type AnCard,
} from "@/lib/analytics/labels";

export const Route = createFileRoute("/_authenticated/analytics/")({
  head: () => ({ meta: [{ title: "Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsHomePageSkeleton,
  component: AnalyticsHomePage,
});

/**
 * Главная «Аналитики» — как главная старого портала аналитики: приветствие и
 * карточки отчётов, которые человеку открыты (их условия показа). Карточки
 * модули добавляют по мере переноса (AN_CARDS).
 */
function AnalyticsHomePage() {
  const access = useAdminAccess();
  const { data: profile } = useStaffProfile();
  const me = access?.analytics;
  const cards: AnCard[] = AN_CARDS.filter((c) => anCan(me, c.need));
  if (anCan(me, AN_MYCITY_CARD.need)) {
    const cities = me?.admin ? [] : (me?.partnerCities ?? []);
    for (const city of cities) {
      cards.push({
        key: `mycity:${city}`,
        title: AN_MYCITY_CARD.cityTitle(city),
        description: AN_MYCITY_CARD.cityDescription,
        url: AN_MYCITY_CARD.url,
        need: AN_MYCITY_CARD.need,
      });
    }
    if (cities.length === 0) {
      cards.push({
        key: "mycity",
        title: AN_MYCITY_CARD.title,
        description: AN_MYCITY_CARD.description,
        url: AN_MYCITY_CARD.url,
        need: AN_MYCITY_CARD.need,
      });
    }
  }
  return (
    <AdminShell title={AN_TITLES.home}>
      <AnalyticsHomeBody
        greeting={profile === undefined ? null : AN_HOME_TEXT.greeting(profile?.fullName ?? "")}
      >
        {cards.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {cards.map((c) => (
              <Link
                key={c.key}
                to={c.url}
                className="group relative flex min-h-28 flex-col gap-1 rounded-lg border bg-background p-5 pr-12 transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="text-base font-semibold">{c.title}</span>
                <span className="text-sm text-muted-foreground">{c.description}</span>
                <ArrowRight className="absolute right-5 bottom-5 size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            ))}
          </div>
        ) : (
          <InfoNote variant="empty">
            <span className="font-medium">{AN_HOME_TEXT.emptyTitle}</span> —{" "}
            {AN_HOME_TEXT.emptyText}
            {me?.admin && " Отчёты появятся здесь по мере переноса модулей."}
          </InfoNote>
        )}
      </AnalyticsHomeBody>
    </AdminShell>
  );
}
