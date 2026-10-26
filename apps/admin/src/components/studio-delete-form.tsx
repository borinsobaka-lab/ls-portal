import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { unwrapPage } from "@/lib/query";

/**
 * Удаление студии: каскадом уходят все её данные, поэтому — с количеством
 * клиентов и продаж и вводом названия. Учётные записи и общий контент
 * приложения остаются (подробно — в миграции).
 */
export function DeleteStudioForm({
  studio,
  onClose,
  onDeleted,
}: {
  studio: { id: string; name: string; format: string };
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [confirmName, setConfirmName] = useState("");
  const [saving, setSaving] = useState(false);
  const matches = confirmName.trim() === studio.name.trim();

  const { data: counts } = useQuery({
    queryKey: ["studios", "delete-counts", studio.id],
    queryFn: async () => {
      const head = { count: "exact" as const, head: true };
      const [clients, sales, heir] = await Promise.all([
        unwrapPage(supabase.from("clients").select("id", head).eq("studio_id", studio.id)),
        unwrapPage(supabase.from("sales").select("id", head).eq("studio_id", studio.id)),
        // Пакетный клуб: клиенты и каталог общие — уходят в самый старый из
        // остальных пакетных (studios_packages_catalog_rehome в базе).
        studio.format === "packages"
          ? supabase
              .from("studios")
              .select("name")
              .eq("format", "packages")
              .neq("id", studio.id)
              .order("created_at")
              .order("id")
              .limit(1)
              .maybeSingle()
          : Promise.resolve({ data: null }),
      ]);
      return {
        clients: clients.count,
        sales: sales.count,
        heir: (heir.data?.name as string | undefined) ?? null,
      };
    },
    meta: { errorMessage: "Не удалось посчитать данные клуба" },
  });

  const handleDelete = async () => {
    if (!matches) {
      toast.error("Введите название клуба точно так, как оно написано");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.rpc("delete_studio", {
        _studio_id: studio.id,
        _confirm_name: confirmName,
      });
      if (error) {
        toast.error("Не удалось удалить клуб: " + error.message);
        return;
      }
      toast.success(`Клуб «${studio.name}» удалён`);
      onClose();
      onDeleted();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Удалить клуб?</DialogTitle>
        <DialogDescription>
          Клуб «{studio.name}» будет удалён вместе со всеми его данными. Отменить это нельзя.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={handleDelete}>
        <DialogBody>
          <div className="space-y-4">
            {counts?.heir ? (
              // Пакетный клуб: база клиентов и каталог общие для пакетных клубов.
              <InfoNote variant="warning">
                Карточки клиентов, заведённые здесь ({counts.clients}), их заявки, тренировки и
                номенклатура перейдут в клуб «{counts.heir}» — у пакетных клубов они общие. Удалятся
                продажи этого клуба ({counts.sales}) и абонементы по ним, касса, расписание и записи
                на его занятия, промокоды, доступы сотрудников в этом клубе. Останутся учётные
                записи людей, справочник сотрудников, новости, услуги и пуши приложения.
              </InfoNote>
            ) : (
              <InfoNote variant="warning">
                Удалятся карточки клиентов
                {counts ? ` (${counts.clients})` : ""}, продажи
                {counts ? ` (${counts.sales})` : ""}, абонементы, касса, расписание и записи,
                номенклатура, промокоды, доступы сотрудников в этом клубе. Останутся учётные записи
                людей, справочник сотрудников, новости, услуги и пуши приложения.
              </InfoNote>
            )}
            <FormField
              label="Название клуба"
              required
              hint={`Введите «${studio.name}», чтобы подтвердить.`}
            >
              <Input
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={studio.name}
                autoComplete="off"
              />
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" variant="destructive" disabled={saving || !matches}>
            {saving && <Loader2 className="animate-spin" />}
            Удалить клуб
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
