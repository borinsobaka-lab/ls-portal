import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { AdminShell } from "@/components/admin-shell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CountBadge } from "@/components/ui/status-chip";
import { TableToolbar } from "@/components/table-toolbar";
import { CallStatsTab } from "@/components/scripts/settings/call-stats";
import { CopyStatsTab } from "@/components/scripts/settings/copy-stats";
import { HistoryTab } from "@/components/scripts/settings/history";
import { ImportTab } from "@/components/scripts/settings/import";
import { SubstitutionTab } from "@/components/scripts/settings/substitution";
import { SuggestionsTab, type SeenBefore } from "@/components/scripts/settings/suggestions";
import { supabase } from "@/integrations/supabase/client";
import {
  markSuggestionsSeen,
  UNREAD_KEY,
  useScriptAccess,
  useUnreadSuggestions,
} from "@/lib/scripts/data";
import {
  ScriptsSettingsBodySkeleton,
  ScriptsSettingsPageSkeleton,
} from "@/components/page-skeletons";

const TABS = ["history", "suggestions", "stats", "calls", "vars", "import"] as const;
type SettingsTab = (typeof TABS)[number];

const isTab = (v: unknown): v is SettingsTab => TABS.some((t) => t === v);

export const Route = createFileRoute("/_authenticated/scripts/settings")({
  head: () => ({ meta: [{ title: "Настройки скриптов — Lady Stretch" }] }),
  // Вкладка — в адресе: ссылкой можно поделиться, «Назад» не теряет её.
  validateSearch: (search: Record<string, unknown>): { tab?: SettingsTab } => ({
    tab: isTab(search.tab) ? search.tab : undefined,
  }),
  pendingComponent: ScriptsSettingsPageSkeleton,
  component: ScriptsSettingsPage,
});

function ScriptsSettingsPage() {
  const access = useScriptAccess();
  const { tab } = Route.useSearch();

  return (
    <AdminShell title="Настройки скриптов">
      {access === null ? (
        <ScriptsSettingsBodySkeleton tab={tab} />
      ) : !access.canRead ? (
        <div className="rounded-lg border bg-background p-8 text-center text-sm text-muted-foreground">
          Раздел «Скрипты LS» вам не открыт — доступ выдаёт владелец в «Доступах».
        </div>
      ) : (
        <SettingsTabs canEdit={access.canEdit} />
      )}
    </AdminShell>
  );
}

function SettingsTabs({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: Route.fullPath });
  const { tab: asked } = Route.useSearch();
  const { data: unread } = useUnreadSuggestions(canEdit);

  // Пришли по значку новых предложений — сразу к ним, иначе — хронология.
  // Решаем один раз, когда счётчик известен: после прочтения он обнулится,
  // и вкладка не должна от этого перескакивать.
  const [initial, setInitial] = useState<SettingsTab | null>(null);
  if (initial === null && (unread !== undefined || !canEdit))
    setInitial(unread ? "suggestions" : "history");
  const requested = asked === "import" && !canEdit ? undefined : asked;
  const tab: SettingsTab = requested ?? initial ?? "history";

  // Открыли предложения — прочитали: значок гаснет. Подсветка новых остаётся
  // до ухода со страницы — по отметке, какой она была до первого открытия.
  const [seenBefore, setSeenBefore] = useState<SeenBefore>();
  const marking = useRef(false);
  useEffect(() => {
    if (tab !== "suggestions" || marking.current) return;
    marking.current = true;
    void (async () => {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user.id ?? null;
      const at = await markSuggestionsSeen();
      setSeenBefore((prev) => prev ?? { at, userId });
      marking.current = false;
      void queryClient.invalidateQueries({ queryKey: [UNREAD_KEY] });
    })();
  }, [tab, queryClient]);

  const tabs: { key: SettingsTab; label: string; badge?: number }[] = [
    { key: "history", label: "Хронология" },
    { key: "suggestions", label: "Предложения", badge: unread },
    { key: "stats", label: "Статистика" },
    { key: "calls", label: "Звонки" },
    { key: "vars", label: "Подстановка" },
    ...(canEdit ? [{ key: "import" as const, label: "Импорт" }] : []),
  ];

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => {
        if (isTab(v)) void navigate({ search: { tab: v }, replace: true });
      }}
      className="space-y-3"
    >
      {!canEdit && (
        <p className="text-sm text-muted-foreground">
          Только просмотр: менять настройки могут те, кому выдано «Скрипты LS: правка».
        </p>
      )}
      {/* Табы — на белой плашке фильтров, не прямо на канве; на узком экране
          прокручиваются. */}
      <TableToolbar>
        <div className="toolbar-full max-w-full overflow-x-auto">
          <TabsList>
            {tabs.map((t) => (
              <TabsTrigger key={t.key} value={t.key} className="gap-1.5">
                {t.label}
                {!!t.badge && <CountBadge count={t.badge} />}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </TableToolbar>

      <TabsContent value="history">
        <HistoryTab />
      </TabsContent>
      <TabsContent value="suggestions">
        <SuggestionsTab canEdit={canEdit} seenBefore={seenBefore} />
      </TabsContent>
      <TabsContent value="stats">
        <CopyStatsTab />
      </TabsContent>
      <TabsContent value="calls">
        <CallStatsTab />
      </TabsContent>
      <TabsContent value="vars">
        <SubstitutionTab canEdit={canEdit} />
      </TabsContent>
      {canEdit && (
        <TabsContent value="import">
          <ImportTab />
        </TabsContent>
      )}
    </Tabs>
  );
}
