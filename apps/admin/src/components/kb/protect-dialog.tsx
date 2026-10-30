import { useState } from "react";
import { Loader2 } from "lucide-react";

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
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { KbProtect } from "@/lib/kb/types";

/**
 * «Защита содержимого» статьи (№52–54): как в базе (настройка базы) или
 * включена / выключена у этой статьи.
 */
export function KbProtectForm({
  value,
  baseProtects,
  onSave,
  onDone,
}: {
  value: KbProtect;
  baseProtects: boolean;
  onSave: (value: KbProtect) => Promise<boolean>;
  onDone: () => void;
}) {
  const [protect, setProtect] = useState<KbProtect>(value);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      if (await onSave(protect)) onDone();
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Защита содержимого</DialogTitle>
        <DialogDescription>
          Читатели не смогут выделить и скопировать текст, сохранить картинку и распечатать статью;
          поверх текста — водяной знак с почтой читателя и датой.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="space-y-4">
            <FormField label="У этой статьи">
              <SegmentedControl
                aria-label="Защита содержимого"
                fullWidth
                value={protect}
                onChange={setProtect}
                options={[
                  {
                    value: "inherit",
                    label: baseProtects ? "Как в базе (вкл.)" : "Как в базе (выкл.)",
                    shortLabel: "Как в базе",
                  },
                  { value: "on", label: "Включена" },
                  { value: "off", label: "Выключена" },
                ]}
              />
            </FormField>
            <InfoNote variant="muted">
              Защита в браузере — помеха, а не замок: снимок экрана запретить нельзя. Водяной знак
              покажет, чей это экран. Редакторы базы копировать могут — им нужно править текст.
              Файлы в статье по-прежнему скачиваются.
            </InfoNote>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onDone} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
