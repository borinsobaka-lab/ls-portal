import { createFileRoute } from "@tanstack/react-router";
import { UsersGroupRounded } from "@solar-icons/react";

import { PageShell } from "@/components/page-shell";
import { Card } from "@/components/ui/card";
import { APP_BRAND, IS_PACKAGES } from "@/lib/terms";
import { PackagesStudioPage } from "@/formats/packages/studio-page";
import { getTranslator, useT } from "@/i18n";

export const Route = createFileRoute("/club")({
  head: ({ match }) => {
    const t = getTranslator(match.context.locale);
    return {
      meta: [
        { title: `${IS_PACKAGES ? t("Студия") : t("Клуб")} — ${APP_BRAND}` },
        {
          name: "description",
          content: IS_PACKAGES
            ? t("О студии и её тренерах.")
            : t("Челленджи, участники и жизнь клуба Base40."),
        },
      ],
    };
  },
  // Пакетное приложение — раздел «Студия» (src/formats/packages/).
  component: IS_PACKAGES ? PackagesStudioPage : ClubPage,
});

function ClubPage() {
  const t = useT();
  return (
    <PageShell
      header={
        <div className="pt-4 pb-8 px-4">
          <h1 className="text-3xl font-semibold">{t("Клуб")}</h1>
          <p className="text-sm text-white/70">{t("Челленджи, участники и события")}</p>
        </div>
      }
    >
      <div className="p-4">
        <Card className="flex flex-col items-center justify-center gap-3 p-10 text-center">
          <UsersGroupRounded className="h-10 w-10 text-muted-foreground" weight="BoldDuotone" />
          <div className="text-base font-semibold">{t("Здесь скоро появится сообщество")}</div>
          <p className="text-sm text-muted-foreground">
            {t("Челленджи, рейтинги и другие участники появятся в одном из ближайших обновлений.")}
          </p>
        </Card>
      </div>
    </PageShell>
  );
}
