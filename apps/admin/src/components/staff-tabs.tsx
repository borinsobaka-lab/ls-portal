import { type ReactNode } from "react";
import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";

import { TableToolbar } from "@/components/table-toolbar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { STAFF_ITEMS } from "@/lib/nav-sections";

/**
 * Вкладки раздела «Сотрудники» (пункт блока «Клуб» в меню клуба, решение
 * владельца 2026-10-13): «Сотрудники», «Зарплаты», «График», «Ставки» —
 * отдельные страницы, вкладка переключает страницу. Стоит первой на каждой
 * из них — строкой табов на белой плашке фильтров (TableToolbar, проп
 * `tabs`), не прямо на канве; `children` — контролы страницы второй строкой
 * той же плашки (листание месяца в «Графике»). Скелетон — `StaffTabsSkeleton` в page-skeletons.tsx.
 *
 * activationMode="manual": стрелки только двигают фокус, переход — по клику,
 * Enter или пробелу (иначе каждая стрелка открывала бы страницу).
 */
export function StaffTabs({ children }: { children?: ReactNode }) {
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current = STAFF_ITEMS.find((i) => pathname === i.url)?.url ?? STAFF_ITEMS[0].url;

  return (
    <TableToolbar
      tabs={
        <Tabs
          value={current}
          onValueChange={(url) => navigate({ to: url })}
          activationMode="manual"
        >
          {/* На узком экране строка табов прокручивается. */}
          <TabsList aria-label="Разделы сотрудников">
            {STAFF_ITEMS.map((item) => (
              <TabsTrigger
                key={item.url}
                value={item.url}
                title={item.title}
                // Чанк страницы — заранее, как у ссылок меню (defaultPreload: "intent").
                onMouseEnter={() => router.preloadRoute({ to: item.url }).catch(() => {})}
              >
                {item.tab}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      }
    >
      {children}
    </TableToolbar>
  );
}
