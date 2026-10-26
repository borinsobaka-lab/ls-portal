import { BottomDrawer } from "@/components/bottom-drawer";
import { PrivacyPolicy } from "@/components/privacy-policy";
import { PRIVACY_POLICY_INFO } from "@/lib/legal";
import { useT } from "@/i18n";

/**
 * Политика конфиденциальности в шторке снизу: из профиля (решение владельца
 * 2026-10-15 — выдвигается, как новости и тренировки) и по ссылке у галочки
 * согласия на входе (введённая почта не теряется). Отдельный экран /privacy
 * остаётся для ссылок снаружи приложения.
 */
export function PrivacyPolicyDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  if (!PRIVACY_POLICY_INFO) return null;

  return (
    <BottomDrawer
      open={open}
      onOpenChange={onOpenChange}
      // Заголовок «Privacy Policy» — в самом тексте политики.
      title={t("Политика конфиденциальности")}
      hideTitle
    >
      <PrivacyPolicy info={PRIVACY_POLICY_INFO} />
    </BottomDrawer>
  );
}
