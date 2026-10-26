/**
 * «Предложить изменения» к конкретному скрипту. Неудачный текст чаще всего
 * замечают те, кто им пользуется у стойки, а права правки у них нет.
 * Предложение уходит в «Настройки» → «Предложения» уже со ссылкой на скрипт —
 * там его видят те, кто правит, со счётчиком новых у каждого своим.
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FormField, InfoNote } from "@/components/ui/form-field";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";

export type SuggestTarget = { id: string; title: string; section: string };

export function SuggestDialogContent({
  target,
  onClose,
}: {
  target: SuggestTarget;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [sent, setSent] = useState(false);

  async function send() {
    if (sent) {
      onClose();
      return;
    }
    if (text.trim().length < 3) {
      toast.error("Напишите, что стоит поправить");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from("scripts_suggestions")
        .insert({ text: text.trim(), item_id: target.id });
      if (error) throw new Error(error.message);
      setSent(true);
      queryClient.invalidateQueries({ queryKey: ["scripts_suggestions"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось отправить");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Предложить изменения</DialogTitle>
        <DialogDescription>Увидят те, кто правит скрипты, — в «Настройках».</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={send}>
        <DialogBody>
          <div className="space-y-4">
            <InfoNote className="text-sm">
              <span className="block text-xs font-medium text-muted-foreground uppercase">
                Скрипт
              </span>
              <span className="font-medium text-foreground">{target.title}</span>
              {target.section && <span className="text-muted-foreground"> · {target.section}</span>}
            </InfoNote>
            {sent ? (
              <p className="text-sm">
                <span className="font-medium">Спасибо, отправлено.</span>{" "}
                <span className="text-muted-foreground">
                  Предложение уже в настройках скриптов.
                </span>
              </p>
            ) : (
              <FormField label="Что стоит изменить" required hint="Ctrl/⌘ + Enter — отправить.">
                <Textarea
                  autoFocus
                  rows={6}
                  maxLength={3000}
                  value={text}
                  placeholder="Например: добавить ответ про рассрочку, в EN-версии старая цена"
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
              </FormField>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          {!sent && (
            <Button variant="outline" disabled={saving} onClick={onClose}>
              Отмена
            </Button>
          )}
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {sent ? "Готово" : "Отправить"}
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
