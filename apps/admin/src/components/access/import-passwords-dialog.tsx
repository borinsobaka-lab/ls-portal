import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FileUp, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import { importPortalLogins } from "@/lib/access.functions";
import { accessUsersQuery, invalidateAccess } from "@/lib/access/data";
import { parseTable } from "@/lib/access/import";
import { normalizeName } from "@/lib/access/logic";
import { buildPasswordRows, readPasswordXlsx } from "@/lib/access/password-import";
import { cn } from "@/lib/utils";

const EXAMPLE =
  "Фамилия\tИмя\tЛогин\tПароль\nИванова\tАнна\tivanova\tПароль123\nПетрова\tОльга\tpetrova\tqwerty77";
/** Сколько человек за один вызов сервера (хэш пароля считается на сервере). */
const CHUNK = 25;

/**
 * «Импорт паролей» в «Пользователях» (решение владельца 2026-11-02): логины
 * и пароли Platrum для тех, кто уже есть на портале. Excel-файл или
 * вставка из Excel: фамилия и имя (отдельными колонками или одной), логин,
 * пароль; человек ищется по фамилии и имени вместе. Разбор —
 * lib/access/password-import.ts, запись — importPortalLogins пачками.
 */
export function ImportPasswordsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" anchor="top">
        {open && <ImportPasswordsForm onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function ImportPasswordsForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const save = useServerFn(importPortalLogins);
  const { data: users } = useQuery(accessUsersQuery);
  const [table, setTable] = useState<string[][] | null>(null);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const rows = useMemo(() => {
    const source = table ?? (text.trim() ? parseTable(text) : null);
    return source ? buildPasswordRows(source, users ?? []) : [];
  }, [table, text, users]);
  const ready = rows.filter((r) => !r.error && r.user_id);
  const bad = rows.length - ready.length;

  const readFile = async (file: File) => {
    setReading(true);
    try {
      if (/\.xlsx$/i.test(file.name)) {
        setTable(await readPasswordXlsx(file));
      } else {
        // CSV / текст: Excel сохраняет в UTF-8 или Windows-1251.
        const buf = await file.arrayBuffer();
        let content = new TextDecoder("utf-8").decode(buf);
        if (content.includes("�")) content = new TextDecoder("windows-1251").decode(buf);
        setTable(parseTable(content));
      }
      setFileName(file.name);
      setText("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось прочитать файл");
    } finally {
      setReading(false);
    }
  };

  const run = async () => {
    if (ready.length === 0) {
      toast.error("Нечего импортировать");
      return;
    }
    let ok = 0;
    const failed: string[] = [];
    try {
      for (let i = 0; i < ready.length; i += CHUNK) {
        const part = ready.slice(i, i + CHUNK);
        setProgress(`${Math.min(i + CHUNK, ready.length)} из ${ready.length}`);
        try {
          const res = await save({
            data: {
              rows: part.map((r) => ({
                user_id: r.user_id!,
                login: r.login,
                password: r.password,
              })),
            },
          });
          res.results.forEach((x, j) => {
            if (x.error) failed.push(`Строка ${part[j].line} (${part[j].name}): ${x.error}`);
            else ok++;
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : "ошибка";
          for (const r of part) failed.push(`Строка ${r.line} (${r.name}): ${message}`);
        }
      }
    } finally {
      setProgress(null);
    }
    await invalidateAccess(qc);
    if (failed.length) {
      toast.error(`Записано ${ok}, не получилось ${failed.length}`, {
        description: failed.slice(0, 6).join("\n"),
        duration: 20_000,
      });
    } else {
      toast.success(`Логины и пароли записаны: ${ok}`);
    }
    onDone();
  };

  const saving = progress !== null;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Импорт паролей</DialogTitle>
        <DialogDescription>
          Логины и пароли Platrum для людей, которые уже есть на портале. Колонки: Фамилия, Имя,
          Логин, Пароль — или одна колонка с фамилией и именем вместо первых двух.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={run}>
        <DialogBody>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" asChild disabled={saving || reading}>
                <label className="cursor-pointer">
                  {reading ? <Loader2 className="animate-spin" /> : <FileUp />} Выбрать файл Excel
                  <input
                    type="file"
                    accept=".xlsx,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void readFile(file);
                      e.target.value = "";
                    }}
                  />
                </label>
              </Button>
              {fileName ? (
                <span className="text-xs text-muted-foreground">
                  {fileName} ·{" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => {
                      setTable(null);
                      setFileName(null);
                    }}
                  >
                    убрать
                  </button>
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  или скопируйте колонки в Excel и вставьте ниже
                </span>
              )}
            </div>
            {!fileName && (
              <FormField
                label="Таблица"
                tip="Выделите в Excel колонки вместе со строкой заголовков (Фамилия, Имя, Логин, Пароль — в любом порядке) и вставьте сюда. Без заголовков — по порядку: фамилия, имя, логин, пароль."
              >
                <Textarea
                  rows={5}
                  value={text}
                  placeholder={EXAMPLE}
                  className="font-mono text-xs"
                  onChange={(e) => setText(e.target.value)}
                />
              </FormField>
            )}
            <InfoNote>
              Человек ищется по фамилии и имени вместе — как они записаны на портале; порядок,
              регистр и «ё» не важны. Если у человека уже был логин, он заменится логином и паролем
              из файла. Вход по почте у него останется.
            </InfoNote>
            {rows.length > 0 && (
              <>
                <p className="text-sm">
                  Строк: {rows.length} · будет записано:{" "}
                  <span className="font-medium">{ready.length}</span>
                  {bad > 0 && <span className="text-destructive"> · с ошибкой: {bad}</span>}
                </p>
                <div className="max-h-80 overflow-auto rounded-md border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted text-left">
                      <tr>
                        <th className="px-2 py-1.5 font-medium">Стр.</th>
                        <th className="px-2 py-1.5 font-medium">Фамилия и имя</th>
                        <th className="px-2 py-1.5 font-medium">Логин</th>
                        <th className="px-2 py-1.5 font-medium">Итог</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {rows.map((r) => (
                        <tr key={r.line} className={cn(r.error && "text-muted-foreground")}>
                          <td className="px-2 py-1.5 align-top">{r.line}</td>
                          <td className="px-2 py-1.5 align-top">
                            <div className="font-medium">{r.portal_name ?? (r.name || "—")}</div>
                            {r.portal_name &&
                              normalizeName(r.portal_name) !== normalizeName(r.name) && (
                                <div className="text-muted-foreground">в файле: {r.name}</div>
                              )}
                          </td>
                          <td className="px-2 py-1.5 align-top">{r.login || "—"}</td>
                          <td className="px-2 py-1.5 align-top">
                            {r.error ? (
                              <span className="text-destructive">{r.error} — пропущена</span>
                            ) : (
                              "будет записан"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onDone} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving || ready.length === 0}>
            {saving && <Loader2 className="animate-spin" />}
            {saving ? `Записываю ${progress}` : `Записать ${ready.length || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
