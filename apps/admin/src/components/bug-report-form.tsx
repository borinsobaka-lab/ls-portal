import { useState } from "react";
import { useRouterState } from "@tanstack/react-router";
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
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { ADMIN_VERSION } from "@/lib/app-version";

/** Ошибки RPC portal_bug_report_submit — понятным текстом. */
function submitErrorText(message: string): string {
  if (message.includes("bug_report_rate_limit"))
    return "Слишком много сообщений за последний час — попробуйте позже";
  if (message.includes("bug_report_empty")) return "Опишите, что не так";
  return "Не удалось отправить сообщение: " + message;
}

/**
 * Окно «Сообщить об ошибке» (components/bug-report.tsx): страница
 * запоминается сама — путь с параметрами и заголовок вкладки, — человек
 * пишет, что не так. Версия портала, браузер и размер окна уходят с
 * сообщением: по ним проще повторить ошибку. Разбирает суперадминистратор —
 * «Управление» → «Сообщения об ошибках».
 */
export default function BugReportForm({ onDone }: { onDone: () => void }) {
  // Страница — на момент открытия окна.
  const location = useRouterState({ select: (s) => s.location });
  const [page] = useState(() => ({
    path: `${location.pathname}${location.searchStr ?? ""}${location.hash ? `#${location.hash}` : ""}`,
    title: typeof document === "undefined" ? "" : document.title,
  }));
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!message.trim()) {
      setError("Опишите, что не так");
      return;
    }
    setSaving(true);
    try {
      const { error: rpcError } = await supabase.rpc("portal_bug_report_submit", {
        p_page_path: page.path,
        p_page_title: page.title,
        p_message: message.trim(),
        p_app_version: ADMIN_VERSION,
        p_user_agent: navigator.userAgent,
        p_viewport: `${window.innerWidth}×${window.innerHeight}`,
      });
      if (rpcError) {
        toast.error(submitErrorText(rpcError.message));
        return;
      }
      toast.success("Спасибо! Сообщение отправлено");
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Сообщить об ошибке</DialogTitle>
        <DialogDescription>
          Опишите, что не работает или что нужно исправить. Страницу мы запомнили сами.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={() => void submit()}>
        <DialogBody>
          <div className="space-y-4">
            <InfoNote>
              <span className="block font-medium text-foreground">
                {page.title || "Страница портала"}
              </span>
              <span className="block break-all">{page.path}</span>
            </InfoNote>
            <FormField label="Что случилось" required error={error}>
              <Textarea
                autoFocus
                rows={6}
                maxLength={5000}
                value={message}
                onChange={(e) => {
                  setMessage(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="Например: нажимаю «Опубликовать», а статья остаётся черновиком"
              />
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onDone} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Отправить
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
