import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useRef, useState } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Loader2, Search } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { useNetworkStudioIds } from "@/hooks/use-catalog-studios";
import { useStudios } from "@/hooks/use-studios";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { clientName, phoneSearchTerm, sanitizeSearch } from "@/lib/format";
import { unwrap } from "@/lib/query";
import type { ClubStatus } from "@/lib/client-status";
import { cn } from "@/lib/utils";
import { fieldClass } from "@/components/ui/field-styles";
import { InputClearButton, SearchIcon } from "@/components/ui/search-input";
import type { ClientLike } from "@/components/client-card-dialog";
import { ClubStatusBadge } from "@/components/club-status-badge";

type FoundClient = ClientLike & { club_status: ClubStatus | null };

// Те же колонки, что у раздела «Клиенты»: найденная строка сразу уходит в
// карточку клиента, второй запрос за ней не нужен.
const COLUMNS =
  "id, studio_id, user_id, full_name, first_name, last_name, phone, phone2, email, birthday, gender, " +
  "notes, registration_date, last_visit_date, crm_link, photo_url, club_status";

const LIMIT = 8;

// Карточка клиента тянет за собой формы продажи и правки клиента (с ними —
// libphonenumber-js, ~220 kB): в шапке каждой страницы она шла в первую
// загрузку админки. Теперь — отдельным чанком, загрузка начинается, как
// только сотрудник ставит курсор в поиск.
const loadClientCard = () => import("@/components/client-card-dialog");
const ClientCardDialog = lazy(() =>
  loadClientCard().then((m) => ({ default: m.ClientCardDialog })),
);

/**
 * Условие PostgREST `.or()` для поиска клиента. Слова имени ищутся каждое
 * по отдельности: search_name — «Фамилия Имя», а набирают и «Имя Фамилия».
 */
function clientSearchFilter(term: string) {
  const words = term.split(" ");
  const name =
    words.length > 1
      ? `and(${words.map((w) => `search_name.ilike.%${w}%`).join(",")})`
      : `search_name.ilike.%${term}%`;
  const phone = phoneSearchTerm(term);
  return `${name},phone.ilike.%${phone}%,phone2.ilike.%${phone}%,email.ilike.%${term}%`;
}

const itemClass =
  "flex cursor-pointer items-center gap-3 rounded-sm px-2 py-2 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground";

/** Строка найденного клиента; `studioName` — клуб клиента из другого клуба. */
function FoundItem({
  c,
  studioName,
  onSelect,
}: {
  c: FoundClient;
  studioName?: string;
  onSelect: (id: string) => void;
}) {
  const contacts = [c.phone, c.phone2, c.email].filter(Boolean).join(" · ") || "Нет контактов";
  return (
    <CommandPrimitive.Item value={c.id} onSelect={onSelect} className={itemClass}>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{clientName(c)}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {studioName ? `${studioName} · ${contacts}` : contacts}
        </span>
      </span>
      {c.club_status && <ClubStatusBadge status={c.club_status} className="shrink-0" />}
    </CommandPrimitive.Item>
  );
}

/**
 * Поиск клиента в шапке AdminShell: имя, фамилия, телефон или почта в
 * базе клиентов активного клуба (у пакетного — общая база всех пакетных
 * клубов, 2026-10-17). Выбор (клик или Enter) открывает карточку клиента —
 * как клик по имени в любой таблице. Стрелки ↑/↓ — по списку, Esc — очистить.
 *
 * Под клиентами клуба — пункт «Искать в другом клубе» (решение владельца
 * 2026-10-14): тот же поиск по остальным клубам сотрудника с другой базой
 * клиентов, найденные — ниже, с названием клуба; карточка такого клиента
 * работает в его клубе.
 */
export function HeaderClientSearch({ className }: { className?: string }) {
  const studioId = useActiveStudioId();
  const networkIds = useNetworkStudioIds(studioId);
  const { data: studios = [] } = useStudios();
  const otherStudios = studios.filter((s) => s.id !== studioId && !networkIds?.includes(s.id));
  const otherIds = otherStudios.map((s) => s.id);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [client, setClient] = useState<FoundClient | null>(null);
  const [cardOpen, setCardOpen] = useState(false);
  const term = sanitizeSearch(useDebouncedValue(query, 250));
  // Запрос, для которого нажали «Искать в другом клубе»: новый текст поиска
  // снова ищет только в активном клубе, пока не нажмут ещё раз.
  const [otherTerm, setOtherTerm] = useState<string | null>(null);
  const searchOthers = !!term && otherTerm === term && otherIds.length > 0;

  const { data: found = [], isFetching } = useQuery({
    queryKey: ["clients_with_status", studioId, "header-search", networkIds?.join(","), term],
    queryFn: () =>
      unwrap<FoundClient[]>(
        supabase
          .from("clients_with_status")
          .select(COLUMNS)
          .in("studio_id", networkIds!)
          .or(clientSearchFilter(term))
          .order("full_name", { ascending: true })
          .limit(LIMIT),
      ),
    enabled: !!studioId && !!networkIds && !!term,
    placeholderData: keepPreviousData,
    meta: { errorMessage: "Не удалось найти клиентов" },
  });

  const { data: foundOther = [], isFetching: fetchingOther } = useQuery({
    queryKey: ["clients_with_status", "header-search-other", otherIds.join(","), term],
    queryFn: () =>
      unwrap<FoundClient[]>(
        supabase
          .from("clients_with_status")
          .select(COLUMNS)
          .in("studio_id", otherIds)
          .or(clientSearchFilter(term))
          .order("full_name", { ascending: true })
          .limit(LIMIT),
      ),
    enabled: searchOthers,
    meta: { errorMessage: "Не удалось найти клиентов в других клубах" },
  });
  const studioName = (id: string | null | undefined) => otherStudios.find((s) => s.id === id)?.name;

  const open = focused && !!sanitizeSearch(query);
  // Пока ответ по новому запросу не пришёл, keepPreviousData держит прошлый
  // список — «никого не нашли» показываем только по актуальному ответу.
  const settled = !isFetching && term === sanitizeSearch(query);

  const pick = (id: string) => {
    const c = found.find((f) => f.id === id) ?? foundOther.find((f) => f.id === id);
    if (!c) return;
    setClient(c);
    setCardOpen(true);
    setQuery("");
    inputRef.current?.blur();
  };

  return (
    <>
      <CommandPrimitive
        shouldFilter={false}
        // Esc: сначала стирает запрос, по пустому — уводит фокус из поиска.
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          if (query) setQuery("");
          else inputRef.current?.blur();
        }}
        className={cn("relative", className)}
      >
        <SearchIcon />
        <CommandPrimitive.Input
          ref={inputRef}
          value={query}
          onValueChange={setQuery}
          onFocus={() => {
            setFocused(true);
            void loadClientCard();
          }}
          onBlur={() => setFocused(false)}
          disabled={!studioId}
          inputMode="search"
          aria-label="Поиск клиента"
          placeholder={studioId ? "Поиск клиента: имя, телефон, почта" : "Сначала выберите клуб"}
          data-field=""
          // Поле как все (field-styles): та же заливка, что в фильтрах и формах.
          className={cn(fieldClass, "flex pl-9 pr-9")}
        />
        {query && (
          <InputClearButton onClear={() => setQuery("")}>
            {isFetching ? <Loader2 className="animate-spin" /> : undefined}
          </InputClearButton>
        )}

        {open && (
          <CommandPrimitive.List
            // Клик по строке не должен сначала снять фокус с поля: blur
            // спрятал бы список раньше, чем дошёл click.
            onMouseDown={(e) => e.preventDefault()}
            className="absolute inset-x-0 top-full z-50 mt-1 max-h-[min(24rem,60vh)] overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
          >
            {found.length === 0 && (
              <div className="py-6 text-center text-sm text-muted-foreground">
                {settled ? "Никого не нашли" : "Ищем…"}
              </div>
            )}
            {found.map((c) => (
              <FoundItem key={c.id} c={c} onSelect={pick} />
            ))}
            {otherIds.length > 0 &&
              (searchOthers ? (
                <CommandPrimitive.Group
                  heading="Другие клубы"
                  className="mt-1 border-t pt-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
                >
                  {foundOther.length === 0 && (
                    <div className="py-4 text-center text-sm text-muted-foreground">
                      {fetchingOther ? "Ищем…" : "В других клубах никого не нашли"}
                    </div>
                  )}
                  {foundOther.map((c) => (
                    <FoundItem
                      key={c.id}
                      c={c}
                      studioName={studioName(c.studio_id)}
                      onSelect={pick}
                    />
                  ))}
                </CommandPrimitive.Group>
              ) : (
                term && (
                  <CommandPrimitive.Item
                    value="__search-other-studios"
                    onSelect={() => setOtherTerm(term)}
                    className={cn(itemClass, "mt-1 border-t text-muted-foreground")}
                  >
                    <Search className="size-4" />
                    {otherStudios.length === 1
                      ? `Искать в клубе «${otherStudios[0].name}»`
                      : "Искать в другом клубе"}
                  </CommandPrimitive.Item>
                )
              ))}
          </CommandPrimitive.List>
        )}
      </CommandPrimitive>

      {/* Карточку монтируем с первым выбором и не снимаем: закрытие — анимация Radix. */}
      {client && (
        <Suspense fallback={null}>
          <ClientCardDialog open={cardOpen} onOpenChange={setCardOpen} client={client} />
        </Suspense>
      )}
    </>
  );
}
