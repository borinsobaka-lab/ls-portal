import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AltArrowRight, UsersGroupRounded } from "@solar-icons/react";

import { PageShell } from "@/components/page-shell";
import { UnderlineTabs } from "@/components/underline-tabs";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SquircleAvatar,
  SquircleAvatarFallback,
  SquircleAvatarImage,
} from "@/components/ui/squircle-avatar";
import { useFormatStudios, useViewedStudioId } from "@/hooks/use-viewed-studio";
import { msg, useLocalize, useT } from "@/i18n";
import { mediaUrl } from "@/lib/media";
import { trainerInitials } from "./entries";
import { AboutTab } from "./about-page";
import {
  STAFF_ROLE_TEXT,
  staffHasRating,
  staffOrder,
  staffRole,
  staffRoleLabel,
  studioStaffQuery,
  type StaffRole,
} from "./queries";
import { TrainerDrawer } from "./trainer-drawer";
import { TrainerRatingLine } from "./trainer-rating";

/**
 * «Студия» пакетного приложения (до 2026-10-11 — заглушка «Клуб»): вкладки
 * сотрудников смотримой студии (переключатель на главной; «Сотрудники» в
 * админке, роль — trainers.role) и «О нас».
 *
 * - «Тренеры» — биография, рейтинг и чаевые;
 * - «Администраторы» (2026-10-12) — описание и чаевые, без рейтинга: их не
 *   оценивают;
 * - «Массажисты» (2026-10-12) — как тренеры: рейтинг (прежний сервис +
 *   оценки клиентов) и чаевые;
 * - «О нас» — история бренда Lady Stretch, общая для студий (about-page.tsx;
 *   до 2026-10-12 здесь была «О студии» с фото, картами и соцсетями каждой
 *   студии).
 *
 * Карточка сотрудника — шторка trainer-drawer.tsx.
 */

const TABS = [
  { key: "trainer", label: msg("Тренеры") },
  { key: "admin", label: msg("Админы") },
  { key: "masseur", label: msg("Массажисты") },
  { key: "about", label: msg("О нас") },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/** Тексты вкладки сотрудников: подзаголовок без названия студии и пустой список. */
const STAFF_TEXT: Record<StaffRole, { subtitle: string; empty: string }> = {
  trainer: { subtitle: msg("Тренеры студии"), empty: msg("Тренеры студии скоро появятся") },
  admin: {
    subtitle: msg("Администраторы студии"),
    empty: msg("Администраторы студии скоро появятся"),
  },
  masseur: {
    subtitle: msg("Массажисты студии"),
    empty: msg("Массажисты студии скоро появятся"),
  },
};

export function PackagesStudioPage() {
  const t = useT();
  const loc = useLocalize();
  const [tab, setTab] = useState<TabKey>("trainer");
  const { studioId } = useViewedStudioId();
  const { data: studios = [] } = useFormatStudios();
  const studioName = loc(studios.find((s) => s.id === studioId))?.name ?? null;
  const tabs = useMemo(() => TABS.map((x) => ({ ...x, label: t(x.label) })), [t]);

  return (
    // scrollKey не зависит от вкладки: иначе смена вкладки пересоздавала
    // страницу — прокрутка прыгала наверх, подчёркивание табов не перетекало.
    <PageShell
      scrollKey="studio"
      header={
        <div className="pt-4 pb-8 px-4">
          <h1 className="text-3xl font-semibold">{t("Студия")}</h1>
          <p className="text-sm text-white/70">
            {tab === "about" ? t("Наша история") : (studioName ?? t(STAFF_TEXT[tab].subtitle))}
          </p>
        </div>
      }
    >
      <UnderlineTabs
        tabs={tabs}
        value={tab}
        onChange={setTab}
        className="px-4 pt-4"
        gapClass="gap-6"
      />
      {tab === "about" ? (
        <AboutTab />
      ) : (
        <div className="p-4">
          <StaffTab role={tab} />
        </div>
      )}
    </PageShell>
  );
}

function StaffTab({ role }: { role: StaffRole }) {
  const { studioId, studioReady } = useViewedStudioId();
  // id, а не строка: после оценки список перезагружается с новым рейтингом.
  const [openId, setOpenId] = useState<string | null>(null);
  const t = useT();
  const loc = useLocalize();
  const { data: rows, isPending, error } = useQuery(studioStaffQuery(studioId, studioReady));
  // Имена — на языке клиента, порядок — руководитель студии первым, дальше
  // по переведённому имени.
  const data = useMemo(
    () =>
      rows
        ?.filter((row) => staffRole(row) === role)
        .map((row) => ({ row, tr: loc(row) }))
        .sort(
          (a, b) =>
            staffOrder(a.row) - staffOrder(b.row) ||
            a.tr.full_name.localeCompare(b.tr.full_name, t.intl),
        ),
    [rows, role, loc, t],
  );

  if (!studioReady || (isPending && !!studioId)) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="flex items-center gap-3 p-3">
            <Skeleton className="h-14 w-14 rounded-2xl" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </Card>
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <Card className="p-4 text-sm text-destructive">
        {t("Не удалось загрузить сотрудников. Обновите страницу.")}
      </Card>
    );
  }
  const open = rows?.find((tr) => tr.id === openId) ?? null;
  if (!data || data.length === 0) {
    return (
      <Card className="flex flex-col items-center gap-3 p-8 text-center text-sm text-muted-foreground">
        <UsersGroupRounded className="h-10 w-10" weight="BoldDuotone" />
        {t(STAFF_TEXT[role].empty)}
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-3">
        {data.map(({ tr }) => {
          const photo = mediaUrl(tr.photo_url, "trainer-photos");
          return (
            <button
              key={tr.id}
              type="button"
              onClick={() => setOpenId(tr.id)}
              className="w-full text-left transition active:scale-[0.99]"
            >
              <Card className="flex items-center gap-3 p-3">
                <SquircleAvatar size={56} className="shrink-0">
                  {photo && <SquircleAvatarImage src={photo} alt={tr.full_name} />}
                  <SquircleAvatarFallback className="bg-muted text-base font-semibold text-muted-foreground">
                    {trainerInitials(tr.full_name)}
                  </SquircleAvatarFallback>
                </SquircleAvatar>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-base font-semibold">{tr.full_name}</div>
                  <div className="mt-1">
                    {staffHasRating(role) ? (
                      <TrainerRatingLine
                        avg={tr.rating_avg}
                        count={tr.rating_count}
                        starClass="h-3.5 w-3.5"
                        textClass="text-xs"
                      />
                    ) : (
                      <div className="text-xs text-muted-foreground">{t(staffRoleLabel(tr))}</div>
                    )}
                  </div>
                </div>
                <AltArrowRight className="h-5 w-5 shrink-0 text-muted-foreground" />
              </Card>
            </button>
          );
        })}
      </div>

      <TrainerDrawer trainerId={openId} initial={open} onClose={() => setOpenId(null)} />
    </>
  );
}
