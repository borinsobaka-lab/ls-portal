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
import { SwitchRow } from "@/components/ui/form-field";
import type { KbTreeNode } from "@/lib/kb/types";

type Settings = Pick<KbTreeNode, "feedback_enabled" | "pager_enabled">;

/**
 * «Настройки страницы» статьи (решение владельца 2026-10-25): оценка в конце
 * статьи и переход к предыдущей и следующей — у новых статей включены, у
 * отдельной статьи их можно выключить.
 */
export function KbPageSettingsForm({
  value,
  onSave,
  onDone,
}: {
  value: Settings;
  onSave: (value: Settings) => Promise<boolean>;
  onDone: () => void;
}) {
  const [feedback, setFeedback] = useState(value.feedback_enabled);
  const [pager, setPager] = useState(value.pager_enabled);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      if (await onSave({ feedback_enabled: feedback, pager_enabled: pager })) onDone();
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Настройки страницы</DialogTitle>
        <DialogDescription>Что показывать читателям в конце этой статьи.</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="space-y-3">
            <SwitchRow
              title="Оценка статьи"
              hint="«Была ли статья полезной?» и три смайлика. Оценки — в аналитике базы."
              checked={feedback}
              onCheckedChange={setFeedback}
            />
            <SwitchRow
              title="Предыдущая и следующая статья"
              hint="Переход к соседним статьям по порядку меню базы."
              checked={pager}
              onCheckedChange={setPager}
            />
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
