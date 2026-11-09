/**
 * «Не беспокоить ▾» на плашке «Уведомлений» (UI_REVIEW, 5.7.1): на час, на
 * 3 часа, до утра (9:00 в поясе человека) — выключить уведомления на вечер в
 * два нажатия, без похода в настройки. Пишет то же поле, что настройки
 * (`portal_settings_save`, `dnd_until`).
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { BellOff, ChevronDown, Clock } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ListItemButton } from "@/components/ui/list-item-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { dndActive, usePortalSettings, useSavePortalSettings } from "@/lib/notifications/data";
import { dndUntilText, untilMorning } from "@/lib/notifications/feed-logic";
import { NOTIFICATIONS_SETTINGS_URL } from "@/lib/nav-sections";

export function DndMenu() {
  const { data: settings } = usePortalSettings();
  const save = useSavePortalSettings();
  const [open, setOpen] = useState(false);
  const tz = settings?.timezone ?? "Europe/Moscow";
  const active = dndActive(settings);

  const set = async (until: Date | null) => {
    setOpen(false);
    try {
      const next = await save({ dnd_until: until ? until.toISOString() : null });
      toast.success(
        until && next?.dnd_until
          ? `Не беспокоить ${dndUntilText(next.dnd_until, tz)}`
          : "Уведомления снова приходят",
      );
    } catch (e) {
      toast.error(`Не удалось сохранить: ${(e as Error).message}`);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant={active ? "secondary" : "outline"} disabled={!settings}>
          <BellOff />
          <span className="max-sm:hidden">
            {active && settings?.dnd_until
              ? `Не беспокоить ${dndUntilText(settings.dnd_until, tz)}`
              : "Не беспокоить"}
          </span>
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1">
        <p className="px-3 pt-2 pb-1 text-xs text-muted-foreground">
          На устройство ничего не придёт, в ленте всё останется.
        </p>
        <ListItemButton onClick={() => void set(new Date(Date.now() + 3600_000))}>
          <Clock /> На час
        </ListItemButton>
        <ListItemButton onClick={() => void set(new Date(Date.now() + 3 * 3600_000))}>
          <Clock /> На 3 часа
        </ListItemButton>
        <ListItemButton onClick={() => void set(untilMorning(tz))}>
          <Clock /> До утра (9:00)
        </ListItemButton>
        {active && (
          <ListItemButton onClick={() => void set(null)}>
            <BellOff /> Выключить «Не беспокоить»
          </ListItemButton>
        )}
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">
          Каждый день в одно время —{" "}
          <Link
            to={NOTIFICATIONS_SETTINGS_URL}
            className="font-medium text-foreground underline underline-offset-2"
            onClick={() => setOpen(false)}
          >
            тихие часы в настройках
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
