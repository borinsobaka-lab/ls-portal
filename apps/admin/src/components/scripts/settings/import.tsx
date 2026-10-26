/**
 * Импорт скриптов из «Аудиоаналитики»: там «Настройки скриптов» → «Экспорт»
 * скачивает JSON-файл, здесь он загружается целиком. Разделы и скрипты
 * заменяются (RPC scripts_import), из настроек переносятся названия студий и
 * свои переменные. Хронология остаётся — импорт ложится в неё одной записью.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { invalidateScripts, SETTINGS_KEY } from "@/lib/scripts/data";
import { formatWhen, plural } from "@/lib/scripts/logic";
import { HISTORY_KEY } from "./history";
import { StatTile } from "./shared";

const EXPORT_FORMAT = "audio-analitics-scripts";

type Parsed = {
  data: Record<string, unknown>;
  fileName: string;
  sections: number;
  scripts: number;
  calls: number;
  variables: number;
  studios: number;
  exportedAt: string | null;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Разбор файла экспорта. Ошибка — исключение с текстом для сотрудника. */
function parseExport(text: string, fileName: string): Parsed {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Это не JSON — выберите файл, скачанный кнопкой «Экспорт»");
  }
  if (!isRecord(data)) throw new Error("В файле нет набора скриптов");
  if (data.format !== undefined && data.format !== EXPORT_FORMAT)
    throw new Error("Это не экспорт скриптов «Аудиоаналитики»");
  const sections = data.sections;
  if (!Array.isArray(sections) || !sections.length || !sections.every(isRecord))
    throw new Error("В файле нет разделов скриптов");

  // Считаем так же, как scripts_load: раздел с flow — звонок, его items не берутся.
  const isCall = (s: Record<string, unknown>) => s.kind === "call" || isRecord(s.flow);
  const settings = isRecord(data.settings) ? data.settings : {};
  return {
    data,
    fileName,
    sections: sections.length,
    calls: sections.filter(isCall).length,
    scripts: sections
      .filter((s) => !isCall(s))
      .reduce((n, s) => n + (Array.isArray(s.items) ? s.items.length : 0), 0),
    variables: Array.isArray(settings.variables) ? settings.variables.length : 0,
    studios: Array.isArray(settings.studios) ? settings.studios.length : 0,
    exportedAt: typeof data.exported_at === "string" ? data.exported_at : null,
  };
}

export function ImportTab() {
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [problem, setProblem] = useState("");
  const [importing, setImporting] = useState(false);
  // Сменить key — сбросить выбранный файл в поле.
  const [inputKey, setInputKey] = useState(0);

  const pickFile = async (file: File | undefined) => {
    setParsed(null);
    setProblem("");
    if (!file) return;
    try {
      setParsed(parseExport(await file.text(), file.name));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Не удалось прочитать файл");
    }
  };

  const handleImport = async () => {
    if (!parsed) return;
    if (
      !(await confirm({
        title: "Заменить все скрипты?",
        description: `Текущие разделы и скрипты удалятся, вместо них будут ${parsed.sections} ${plural(parsed.sections, "раздел", "раздела", "разделов")} из файла. Хронология правок останется; названия клубов и свои переменные тоже заменятся, имена администраторов — нет.`,
        confirmLabel: "Заменить",
      }))
    )
      return;
    setImporting(true);
    try {
      const { data, error } = await supabase.rpc("scripts_import", { _data: parsed.data });
      if (error) {
        toast.error("Не удалось импортировать скрипты", { description: error.message });
        return;
      }
      const count = typeof data === "number" ? data : parsed.scripts;
      toast.success(`Импортировано: ${count} ${plural(count, "скрипт", "скрипта", "скриптов")}`);
      await Promise.all([
        invalidateScripts(queryClient),
        queryClient.invalidateQueries({ queryKey: [SETTINGS_KEY] }),
        queryClient.invalidateQueries({ queryKey: [HISTORY_KEY] }),
      ]);
      setParsed(null);
      setInputKey((k) => k + 1);
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className="max-w-2xl space-y-4 rounded-lg border bg-background p-4 sm:p-6">
      <div>
        <h2 className="text-lg font-semibold">Импорт из «Аудиоаналитики»</h2>
        <p className="text-sm text-muted-foreground">
          Переносит текущие скрипты из «Аудиоаналитики». Там откройте «Настройки скриптов» →
          «Экспорт» — скачается JSON-файл; выберите его здесь.
        </p>
      </div>

      <InfoNote variant="warning">
        Все разделы и скрипты здесь заменятся содержимым файла. Хронология правок останется, импорт
        ляжет в неё одной записью. Из настроек переносятся названия клубов и свои переменные; имена
        администраторов — нет: там другие учётные записи.
      </InfoNote>

      <FormField label="Файл экспорта" required hint="JSON, скачанный кнопкой «Экспорт».">
        <Input
          key={inputKey}
          type="file"
          accept=".json,application/json"
          disabled={importing}
          onChange={(e) => void pickFile(e.target.files?.[0])}
        />
      </FormField>

      {problem && <p className="text-sm text-destructive">{problem}</p>}

      {parsed && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile
              label={plural(parsed.sections, "раздел", "раздела", "разделов")}
              value={parsed.sections}
            />
            <StatTile
              label={plural(parsed.scripts, "скрипт", "скрипта", "скриптов")}
              value={parsed.scripts}
            />
            <StatTile
              label={plural(parsed.calls, "звонок", "звонка", "звонков")}
              value={parsed.calls}
            />
            <StatTile
              label={plural(parsed.variables, "переменная", "переменные", "переменных")}
              value={parsed.variables}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {parsed.fileName}
            {parsed.exportedAt ? ` · выгружен ${formatWhen(parsed.exportedAt)}` : ""}
            {parsed.studios
              ? ` · ${parsed.studios} ${plural(parsed.studios, "клуб", "клуба", "клубов")}`
              : ""}
          </p>
          <Button onClick={handleImport} disabled={importing}>
            {importing ? <Loader2 className="animate-spin" /> : <Upload />}
            Заменить скрипты
          </Button>
        </div>
      )}

      {confirmDialog}
    </section>
  );
}
