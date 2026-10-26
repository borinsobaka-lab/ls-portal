import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AltArrowLeft } from "@solar-icons/react";

import { PageShell } from "@/components/page-shell";
import { FeedbackForm, useFeedbackStudio } from "@/components/feedback-form";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { parseFeedbackSearch } from "@/lib/feedback";
import { APP_BRAND, IS_PACKAGES } from "@/lib/terms";
import { getTranslator, useLocalize, useT } from "@/i18n";

/**
 * Обратная связь (решение владельца 2026-10-15) — страница для ссылки и
 * QR-кода клуба из админки (`/feedback?studio=<id>`); кнопка «Фидбэк» на
 * главной открывает ту же форму шторкой (components/feedback-form.tsx).
 * Открывается и без входа (PUBLIC_ROUTES в __root.tsx); студия из ссылки
 * подставляется, выбор студии не показывается. Язык — языка приложения;
 * переключатель — только без входа (посетитель по QR-коду ещё не выбирал
 * язык).
 */
export const Route = createFileRoute("/feedback")({
  validateSearch: parseFeedbackSearch,
  head: ({ match }) => {
    const t = getTranslator(match.context.locale);
    return {
      meta: [
        { title: t("Обратная связь — {brand}", { brand: APP_BRAND }) },
        {
          name: "description",
          content: t("Расскажите, что понравилось и что можно улучшить."),
        },
      ],
    };
  },
  component: FeedbackPage,
});

function FeedbackPage() {
  const t = useT();
  const loc = useLocalize();
  const { session } = useAuth();
  const search = Route.useSearch();
  const { studios, fixedStudio } = useFeedbackStudio(search.studio);
  const [sent, setSent] = useState(false);

  const studioName = fixedStudio && studios.length > 1 ? loc(fixedStudio).name : null;

  return (
    <PageShell
      scrollKey={sent ? "sent" : "form"}
      header={
        <div className="px-4 pt-4 pb-8">
          <div className="flex items-center gap-3">
            {session && (
              <Link
                to="/"
                aria-label={t("Назад")}
                className="h-9 w-9 shrink-0 rounded-full flex items-center justify-center bg-white/10 active:bg-white/20 transition-colors"
              >
                <AltArrowLeft className="h-5 w-5" weight="BoldDuotone" />
              </Link>
            )}
            <h1 className="flex-1 text-2xl font-semibold leading-tight">{t("Обратная связь")}</h1>
            {!session && <LanguageSwitcher />}
          </div>
          <p className="mt-2 text-sm text-white/70">
            {studioName
              ? IS_PACKAGES
                ? t("Студия {name}. Расскажите, что понравилось и что можно улучшить.", {
                    name: studioName,
                  })
                : t("Клуб {name}. Расскажите, что понравилось и что можно улучшить.", {
                    name: studioName,
                  })
              : t("Расскажите, что понравилось и что можно улучшить.")}
          </p>
        </div>
      }
    >
      <div className="px-4 pt-6 pb-10">
        <FeedbackForm
          linkStudioId={search.studio}
          onSentChange={setSent}
          doneAction={
            session && (
              <Button asChild variant="outline" className="w-full">
                <Link to="/">{t("На главную")}</Link>
              </Button>
            )
          }
        />
      </div>
    </PageShell>
  );
}
