import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { APP_BRAND } from "@/lib/terms";
import { AltArrowLeft } from "@solar-icons/react";
import { supabase } from "@/integrations/supabase/client";
import { mediaUrl } from "@/lib/media";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FormattedText } from "@/lib/formatted-text";
import { getTranslator, useLocalize, useT, type ContentTranslations } from "@/i18n";

export const Route = createFileRoute("/news/$newsId")({
  head: ({ match }) => {
    const t = getTranslator(match.context.locale);
    return {
      meta: [
        { title: t("Новость — {brand}", { brand: APP_BRAND }) },
        { name: "description", content: t("Новость {brand}.", { brand: APP_BRAND }) },
      ],
    };
  },
  component: NewsDetailPage,
});

type NewsItem = {
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

// Корень страницы — h-full, а не flex-1: <main> в AppShell не flex-контейнер
// (overflow-hidden с фиксированной высотой), поэтому flex-1 ничего не давал,
// внутренний overflow-y-auto рос по контенту, и длинная новость обрезалась
// без возможности прокрутки.
function NewsDetailPage() {
  const t = useT();
  const loc = useLocalize();
  const { newsId } = Route.useParams();
  const [raw, setItem] = useState<NewsItem | null>(null);
  const item = loc(raw);
  const [loading, setLoading] = useState(true);
  const [imgLoaded, setImgLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setImgLoaded(false);
    supabase
      .from("news")
      .select(
        "id,title,description,image_url,banner_url,full_title,full_text,button_text,button_url,translations",
      )
      .eq("id", newsId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setItem((data as NewsItem | null) ?? null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [newsId]);

  if (loading) {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="flex-1 overflow-y-auto pb-24">
          <div className="px-4 pt-4">
            <Skeleton className="w-full aspect-[4/3] rounded-xl" />
          </div>
          <div className="px-4 mt-5 space-y-3">
            <Skeleton className="h-7 w-3/4 rounded-md" />
            <Skeleton className="h-4 w-full rounded-md" />
            <Skeleton className="h-4 w-5/6 rounded-md" />
            <Skeleton className="h-4 w-2/3 rounded-md" />
          </div>
        </div>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="p-6 text-center space-y-3">
        <div className="text-lg font-semibold">{t("Новость не найдена")}</div>
        <Link to="/" className="text-sm text-primary underline">
          {t("Вернуться на главную")}
        </Link>
      </div>
    );
  }

  // Внутри — только баннер. Картинка превью (image_url) — для карточки на
  // главном экране; без баннера сразу заголовок и текст.
  const hero = mediaUrl(item.banner_url);
  const title = item.full_title || item.title;
  const hasCta = !!item.button_text && !!item.button_url;

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto pb-24">
        {/* Без баннера кнопка «Назад» стоит над заголовком, не на картинке. */}
        <div className={hero ? "relative" : "relative h-12"}>
          {hero && (
            <div className="px-4 pt-4">
              <div className="relative w-full aspect-[4/3]">
                {!imgLoaded && <Skeleton className="absolute inset-0 rounded-xl" />}
                <img
                  src={hero}
                  alt={title}
                  onLoad={() => setImgLoaded(true)}
                  onError={() => setImgLoaded(true)}
                  className={`w-full aspect-[4/3] object-cover rounded-xl transition-opacity duration-200 ${imgLoaded ? "opacity-100" : "opacity-0"}`}
                />
              </div>
            </div>
          )}
          <Link
            to="/"
            aria-label={t("Назад")}
            className="absolute top-3 left-3 h-9 w-9 rounded-full flex items-center justify-center bg-background/85 backdrop-blur active:bg-background transition-colors"
          >
            <AltArrowLeft className="h-5 w-5" weight="BoldDuotone" />
          </Link>
        </div>

        <div className="px-4 mt-5 space-y-3">
          <h1 className="text-2xl font-semibold leading-tight">{title}</h1>
          {item.description && (
            <p className="text-muted-foreground text-base">{item.description}</p>
          )}
          {item.full_text?.trim() && (
            <FormattedText
              text={item.full_text}
              className="text-foreground text-[15px] leading-relaxed pt-2"
              linkClass="font-medium text-foreground underline decoration-primary decoration-2 underline-offset-2"
            />
          )}
        </div>
      </div>
      {hasCta && (
        <div className="shrink-0 border-t border-border bg-background px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Button asChild className="w-full">
            <a href={item.button_url!} target="_blank" rel="noreferrer noopener">
              {item.button_text}
            </a>
          </Button>
        </div>
      )}
    </div>
  );
}
