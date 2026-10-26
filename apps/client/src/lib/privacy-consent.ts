import { supabase } from "@/integrations/supabase/client";
import { PRIVACY_POLICY_INFO } from "@/lib/legal";

/**
 * Запись согласия после входа: в user_metadata учётной записи — редакция
 * политики (дата вступления в силу) и когда принято. Без миграции; ошибка
 * не мешает входу.
 */
export function recordPrivacyConsent() {
  if (!PRIVACY_POLICY_INFO) return;
  void supabase.auth
    .updateUser({
      data: {
        privacy_policy_version: PRIVACY_POLICY_INFO.effectiveDate,
        privacy_policy_accepted_at: new Date().toISOString(),
      },
    })
    .catch(() => {});
}
