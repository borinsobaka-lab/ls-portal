import { supabase } from "@/integrations/supabase/client";
import { APP_FORMAT } from "@/lib/app-format";

/**
 * Пакетный формат: досчитать очередь абонементов клиента перед тем, как
 * читать действующий абонемент или записываться (RPC
 * packages_settle_my_memberships, db/migrations/2026-10-11_zzz_packages_renewal_queue.sql).
 * Срок текущего абонемента вышел, а продление ждёт — продление становится
 * действующим. Ошибку молча пропускаем: без RPC приложение работает как
 * раньше (RPC нет в сгенерированных типах — вызов без типизации).
 */
export async function settlePackageMemberships() {
  if (APP_FORMAT !== "packages") return;
  try {
    await (supabase as unknown as { rpc: (fn: string) => PromiseLike<unknown> }).rpc(
      "packages_settle_my_memberships",
    );
  } catch {
    // не мешаем основному запросу
  }
}
