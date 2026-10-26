import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { useNetworkStudioIds } from "@/hooks/use-catalog-studios";
import { ClientCardDialog, type ClientLike } from "@/components/client-card-dialog";
import { AmoCrmLinkIcon } from "@/components/amocrm-icon";

/**
 * Ссылка amoCRM клиента, если её не передали сверху. Запрос кэшируется React
 * Query: одна и та же строка в разных таблицах не дёргает базу повторно.
 * По учётной записи — карточка из базы клиентов активного клуба
 * (`networkIds`: у пакетного — все пакетные клубы, там карточка на человека одна).
 */
function useCrmLink(opts: {
  clientId?: string | null;
  userId?: string | null;
  networkIds: string[] | null;
  enabled: boolean;
}) {
  const { clientId, userId, networkIds } = opts;
  return useQuery({
    queryKey: ["client-crm-link", clientId ?? null, userId ?? null, networkIds?.join(",")],
    queryFn: async () => {
      let q = supabase.from("clients").select("id, user_id, crm_link").limit(1);
      if (clientId) q = q.eq("id", clientId);
      else {
        q = q.eq("user_id", userId as string);
        if (networkIds) q = q.in("studio_id", networkIds);
      }
      const { data } = await q.maybeSingle();
      return (data?.crm_link as string | null | undefined) ?? null;
    },
    enabled: opts.enabled && (!!clientId || !!userId),
    staleTime: 5 * 60_000,
  }).data;
}

/**
 * Единый вид имени клиента: `font-medium` + цвет ссылки (`--link`).
 *
 * Вынесено отдельной константой, потому что раздел «Клиенты» рисует имя своей
 * кнопкой (у него карточка уже загружена — перезапрашивать её незачем), и без
 * общей строки классов два места неизбежно разъезжаются по весу шрифта.
 * Любое новое место с именем клиента берёт этот класс, а не копию.
 */
export const clientNameClass =
  "cursor-pointer rounded-sm text-left font-medium whitespace-nowrap text-link underline-offset-2 hover:underline hover:text-link-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Кликабельное имя клиента — при нажатии открывает модальное окно
 * с карточкой клиента (как в разделе «Клиенты»).
 *
 * Если у клиента есть `crm_link`, справа от имени отображается иконка amoCRM,
 * по клику открывающая CRM-карточку клиента в новой вкладке.
 */
export function ClientNameLink({
  clientId,
  userId,
  client,
  crmLink,
  children,
  className,
}: {
  clientId?: string | null;
  userId?: string | null;
  client?: ClientLike | null;
  crmLink?: string | null;
  children: React.ReactNode;
  className?: string;
}) {
  const studioId = useActiveStudioId();
  const networkIds = useNetworkStudioIds(studioId);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<ClientLike | null>(client ?? null);
  const [loading, setLoading] = useState(false);
  // crmLink === undefined — страница ссылку не знает, запрашиваем сами;
  // null — знает, что ссылки нет. Карточка клиента (client/loaded) тоже знает.
  const known = crmLink !== undefined || !!client || !!loaded;
  const fetchedCrm = useCrmLink({ clientId, userId, networkIds, enabled: !known });
  const resolvedCrm = (crmLink ?? client?.crm_link ?? loaded?.crm_link ?? fetchedCrm) || null;

  const handleClick = async () => {
    if (loaded) {
      setOpen(true);
      return;
    }
    if (loading) return;
    setLoading(true);
    try {
      let query = supabase.from("clients").select("*").limit(1);
      if (clientId) {
        query = query.eq("id", clientId);
      } else if (userId) {
        query = query.eq("user_id", userId);
        if (networkIds) query = query.in("studio_id", networkIds);
        else if (studioId) query = query.eq("studio_id", studioId);
      } else {
        toast.error("Карточка клиента недоступна");
        return;
      }
      const { data, error } = await query.maybeSingle();
      if (error) {
        toast.error("Не удалось загрузить клиента: " + error.message);
        return;
      }
      if (!data) {
        toast.error("Клиент не найден");
        return;
      }
      setLoaded(data as ClientLike);
      setOpen(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <button
          type="button"
          onClick={handleClick}
          disabled={loading}
          className={cn(clientNameClass, "disabled:opacity-60", className)}
        >
          {children}
        </button>
        {resolvedCrm && <AmoCrmLinkIcon href={resolvedCrm} />}
      </span>
      <ClientCardDialog open={open} onOpenChange={setOpen} client={loaded} />
    </>
  );
}
