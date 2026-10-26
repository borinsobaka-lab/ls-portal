import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";

/**
 * «Администратор» в продажах (абонементы и прочие продажи, оба формата):
 * кто из администраторов студии продал — выбирается каждый раз из
 * справочника «Сотрудники» (роль «Администратор», отмечена эта студия), а не
 * подставляется вошедший в админку. Так продажу можно внести за коллегу, а
 * зарплата не зависит от учётных записей. Пишется sales.seller_id /
 * other_sales.seller_id + снимок имени admin_name; admin_id — по-прежнему тот,
 * кто внёс (db/migrations/2026-10-11_zzzz_sales_seller.sql).
 */

export const SELLER_TIP =
  "Кто из администраторов клуба продал — продажа идёт в его зарплату. Список — сотрудники с ролью «Администратор» в «Сотрудниках».";

export type StudioStaffRow = {
  id: string;
  full_name: string;
  role: string;
  /** Фото из справочника — аватарка в выпадающих списках (StaffOption). */
  photo_url: string | null;
};

/** Те же колонки и ключ, что у «Расписания» и поля «Тренер», — общий кэш. */
export const STUDIO_STAFF_COLS = "id, full_name, role, photo_url, trainer_studios!inner(studio_id)";

/** Сотрудники студии из справочника (тренеры и администраторы). */
export function useStudioStaff(studioId: string | null) {
  return useQuery({
    queryKey: ["trainers", studioId, STUDIO_STAFF_COLS],
    queryFn: () =>
      unwrap<StudioStaffRow[]>(
        supabase
          .from("trainers")
          .select(STUDIO_STAFF_COLS)
          .eq("trainer_studios.studio_id", studioId!)
          .order("full_name"),
      ),
    enabled: !!studioId,
    meta: { errorMessage: "Не удалось загрузить сотрудников клуба" },
  });
}
