import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { AltArrowLeft } from "@solar-icons/react";
import { APP_BRAND } from "@/lib/terms";

import { PageShell } from "@/components/page-shell";
import { PrivacyPolicy } from "@/components/privacy-policy";
import { useAuth } from "@/hooks/use-auth";
import { PRIVACY_POLICY_INFO } from "@/lib/legal";
import { getTranslator, useT } from "@/i18n";

/**
 * Политика конфиденциальности — единственный юридический документ приложения
 * (из профиля; позже — ссылка у галочки согласия на входе). Открывается и без
 * входа: каркас пускает /privacy без сессии (PUBLIC_ROUTES в __root.tsx).
 * Только у приложения Lady Stretch; в подписочном — переход на главную.
 */
export const Route = createFileRoute("/privacy")({
  head: ({ match }) => {
    const t = getTranslator(match.context.locale);
    return {
      meta: [
        {
          title: `${t("Политика конфиденциальности")} — ${PRIVACY_POLICY_INFO?.brand ?? APP_BRAND}`,
        },
      ],
    };
  },
  component: PrivacyPage,
});

function PrivacyPage() {
  const t = useT();
  const { session } = useAuth();
  // Политика есть только у приложения Lady Stretch (lib/legal.ts).
  if (!PRIVACY_POLICY_INFO) return <Navigate to="/" replace />;

  return (
    <PageShell
      header={
        <div className="flex items-center gap-3 pt-4 pb-8 px-4">
          <Link
            to={session ? "/profile" : "/auth"}
            aria-label={t("Назад")}
            className="h-9 w-9 shrink-0 rounded-full flex items-center justify-center bg-white/10 active:bg-white/20 transition-colors"
          >
            <AltArrowLeft className="h-5 w-5" weight="BoldDuotone" />
          </Link>
          <h1 className="text-2xl font-semibold leading-tight">
            {t("Политика конфиденциальности")}
          </h1>
        </div>
      }
    >
      <div className="px-4 pt-6 pb-10">
        <PrivacyPolicy info={PRIVACY_POLICY_INFO} />
      </div>
    </PageShell>
  );
}
