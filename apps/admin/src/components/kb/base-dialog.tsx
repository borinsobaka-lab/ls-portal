import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { KB_BASES_KEY } from "@/lib/kb/data";
import { KB_DEFAULT_ICON, KB_ICONS } from "@/lib/kb/icons";
import type { KbBase } from "@/lib/kb/types";
import { DEFAULT_BRAND_COLOR } from "@/lib/studio-formats";
import { Button } from "@/components/ui/button";
import { ColorInput } from "@/components/ui/color-input";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField, SwitchRow } from "@/components/ui/form-field";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const TIPS = {
  railTitle:
    "Короткое название на вкладке в шапке базы знаний, рядом с иконкой. Пусто — полное название.",
  description: "Видно в списке баз знаний — для чего база и кому она.",
  color:
    "Внутри базы этим цветом красятся иконка базы в шапке, надзаголовки, метки черновиков и правок, точки в меню, выделение в оглавлении. Без своего цвета — цвет портала.",
  protect:
    "Во всех статьях базы читатели не смогут скопировать текст, сохранить картинку и распечатать; поверх — водяной знак с почтой и датой. У отдельной статьи можно включить или выключить в её меню «⋯».",
};

/**
 * Новая база знаний или её настройки (только владелец; RLS — kb_is_admin).
 * Доступы сотрудникам выдаются в «Доступах», не здесь.
 */
export function KbBaseForm({ base, onDone }: { base: KbBase | null; onDone: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(base?.title ?? "");
  const [railTitle, setRailTitle] = useState(base?.rail_title ?? "");
  const [icon, setIcon] = useState(base?.icon ?? KB_DEFAULT_ICON);
  const [description, setDescription] = useState(base?.description ?? "");
  const [color, setColor] = useState(base?.brand_color ?? "");
  const [protect, setProtect] = useState(base?.protect_content ?? false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const t = title.trim();
    const r = (railTitle.trim() || t).slice(0, 16);
    if (!t) {
      toast.error("Укажите название базы");
      return;
    }
    const brandColor = color.trim().toLowerCase();
    if (brandColor && !/^#[0-9a-f]{6}$/.test(brandColor)) {
      toast.error("Цвет — в формате #RRGGBB");
      return;
    }
    setSaving(true);
    try {
      const row = {
        title: t,
        rail_title: r,
        icon,
        description: description.trim(),
        protect_content: protect,
        brand_color: brandColor || null,
      };
      const { error } = base
        ? await supabase.from("kb_bases").update(row).eq("id", base.id)
        : await supabase.from("kb_bases").insert(row);
      if (error) throw new Error(error.message);
      toast.success(base ? "База знаний сохранена" : "База знаний создана");
      await qc.invalidateQueries({ queryKey: [KB_BASES_KEY] });
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{base ? "База знаний" : "Новая база знаний"}</DialogTitle>
        <DialogDescription>
          Название, иконка, подпись вкладки и цвет. Кто видит базу — настраивается в «Доступах»: по
          умолчанию её видят только владельцы.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="space-y-4">
            <FormField label="Название" required>
              <Input
                value={title}
                maxLength={80}
                placeholder="Например, «Стандарты Lady Stretch»"
                onChange={(e) => setTitle(e.target.value)}
              />
            </FormField>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Подпись вкладки" tip={TIPS.railTitle}>
                <Input
                  value={railTitle}
                  maxLength={16}
                  placeholder={title.trim().slice(0, 16) || "Стандарты"}
                  onChange={(e) => setRailTitle(e.target.value)}
                />
              </FormField>
              <FormField label="Иконка">
                <Select value={icon} onValueChange={setIcon}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KB_ICONS.map((i) => (
                      <SelectItem key={i.key} value={i.key} textValue={i.label}>
                        <span className="flex items-center gap-2">
                          <i.icon className="size-4 text-muted-foreground" />
                          {i.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>
            <FormField label="Описание" tip={TIPS.description}>
              <Textarea
                value={description}
                maxLength={500}
                rows={3}
                onChange={(e) => setDescription(e.target.value)}
              />
            </FormField>
            <FormField label="Фирменный цвет" tip={TIPS.color}>
              <div className="space-y-2">
                <ColorInput value={color} onChange={setColor} fallback={DEFAULT_BRAND_COLOR} />
                {color ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setColor("")}>
                    Как у портала
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Не задан — база в цвете портала. Выберите цвет, чтобы задать свой.
                  </p>
                )}
              </div>
            </FormField>
            <SwitchRow
              title="Защита содержимого"
              tip={TIPS.protect}
              checked={protect}
              onCheckedChange={setProtect}
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onDone} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {base ? "Сохранить" : "Создать"}
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
