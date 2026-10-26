import { useEffect, useState } from "react";
import { Drawer as DrawerPrimitive } from "vaul";

import { supabase } from "@/integrations/supabase/client";
import { untypedDb } from "@/lib/untyped-db";
import { mediaUrl } from "@/lib/media";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FormattedText } from "@/lib/formatted-text";
import { useLocalize, useT, type ContentTranslations } from "@/i18n";

type ContentItem = {
  id: string;
  title: string;
  description: string | null;
  image_url: string | null;
  banner_url: string | null;
  full_title: string | null;
  full_text: string | null;
  button_text: string | null;
  button_url: string | null;
  translations?: ContentTranslations | null;
};

/** Откуда берётся карточка: таблица и бакет с её картинками. */
const SOURCES = {
  news: { table: "news", bucket: "news-media" },
  service: { table: "services", bucket: "services-media" },
} as const;

/**
 * Шторка с полным текстом новости или услуги (одинаковая разметка и набор
 * полей; раньше это были два почти дословных компонента).
 */
export function ContentDrawer({
  kind,
  itemId,
  onOpenChange,
}: {
  kind: keyof typeof SOURCES;
  itemId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const loc = useLocalize();
  const open = itemId !== null;
  const { table, bucket } = SOURCES[kind];
  // Результат запоминаем вместе с id, для которого он получен: пока ответ на
  // текущий id не пришёл — показываем скелетон, а не прошлую запись.
  const [result, setResult] = useState<{ id: string; item: ContentItem | null } | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  const loading = itemId !== null && result?.id !== itemId;
  const item = loc(loading ? null : (result?.item ?? null));

  useEffect(() => {
    if (!itemId) return;
    let cancelled = false;
    setImgLoaded(false);
    // services нет в сгенерированных types.ts — общий запрос без типов.
    untypedDb
      .from(table)
      .select(
        "id,title,description,image_url,banner_url,full_title,full_text,button_text,button_url,translations",
      )
      .eq("id", itemId)
      .maybeSingle()
      .then(({ data }: { data: ContentItem | null }) => {
        if (!cancelled) setResult({ id: itemId, item: data ?? null });
      });
    return () => {
      cancelled = true;
    };
  }, [table, itemId]);

  // Внутри — только баннер. Картинка превью (image_url) — для карточки на
  // главном экране; без баннера сразу заголовок и текст.
  const hero = mediaUrl(item?.banner_url, bucket);
  const title = item?.full_title || item?.title || "";
  const hasCta = !!item?.button_text && !!item?.button_url;

  return (
    <DrawerPrimitive.Root open={open} onOpenChange={onOpenChange} shouldScaleBackground>
      <DrawerPrimitive.Portal>
        <DrawerPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DrawerPrimitive.Content
          className="fixed inset-x-0 bottom-0 z-50 flex h-[88vh] flex-col rounded-t-2xl border-t border-border bg-background outline-none"
          aria-describedby={undefined}
        >
          <div className="mx-auto mt-2 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/30" />
          <div className="flex-1 overflow-y-auto overscroll-contain pb-10">
            {loading ? (
              <>
                <div className="px-3 pt-3 space-y-3">
                  <Skeleton className="h-7 w-3/4 rounded-md" />
                  <Skeleton className="h-4 w-full rounded-md" />
                  <Skeleton className="h-4 w-5/6 rounded-md" />
                  <Skeleton className="h-4 w-2/3 rounded-md" />
                </div>
              </>
            ) : !item ? (
              // Запись удалена/скрыта или запрос не прошёл — раньше в этом
              // случае скелетон крутился бесконечно.
              <div className="px-4 pt-10 text-center">
                <DrawerPrimitive.Title className="text-lg font-semibold">
                  {t("Не удалось открыть")}
                </DrawerPrimitive.Title>
                <p className="mt-2 text-sm text-muted-foreground">
                  {t("Запись не найдена или временно недоступна.")}
                </p>
              </div>
            ) : (
              <>
                {hero && (
                  <div className="px-3 pt-1">
                    <div className="relative w-full">
                      {!imgLoaded && <Skeleton className="w-full aspect-[4/3] rounded-2xl" />}
                      <img
                        src={hero}
                        alt={title}
                        onLoad={() => setImgLoaded(true)}
                        onError={() => setImgLoaded(true)}
                        className={cn(
                          "w-full h-auto rounded-2xl transition-opacity duration-200",
                          imgLoaded ? "opacity-100" : "opacity-0 absolute inset-0",
                        )}
                      />
                    </div>
                  </div>
                )}
                <div className="px-3 pt-3 space-y-3">
                  <DrawerPrimitive.Title className="text-2xl font-bold leading-tight">
                    {title}
                  </DrawerPrimitive.Title>
                  {item.full_text?.trim() && (
                    <FormattedText
                      text={item.full_text}
                      className="text-foreground text-[15px] leading-relaxed pt-2"
                      linkClass="font-medium text-foreground underline decoration-primary decoration-2 underline-offset-2"
                    />
                  )}
                </div>
              </>
            )}
          </div>
          {hasCta && (
            <div className="shrink-0 border-t border-border bg-background px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <Button asChild className="w-full">
                <a href={item!.button_url!} target="_blank" rel="noreferrer noopener">
                  {item!.button_text}
                </a>
              </Button>
            </div>
          )}
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    </DrawerPrimitive.Root>
  );
}
