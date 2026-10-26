import { Smartphone } from "@solar-icons/react";

import { useT } from "@/i18n";

/**
 * Приложение — только вертикально (решение владельца 2026-10-13). Android
 * держит ориентацию по манифесту (`orientation: "portrait"`), а iOS (и
 * установленное на экран приложение, и Safari) блокировать поворот не даёт —
 * на повёрнутом телефоне поверх всего экрана просьба повернуть обратно.
 * Показ — чистым CSS (`.rotate-overlay`, styles.css): только телефоны
 * (сенсор, низкий экран в горизонтали), планшеты и компьютеры не трогает.
 */
export function RotateOverlay() {
  const t = useT();
  return (
    <div className="rotate-overlay fixed inset-0 z-[1000] hidden flex-col items-center justify-center gap-3 bg-[#2A2B2F] px-8 text-center text-white">
      <Smartphone className="h-10 w-10 text-primary" weight="BoldDuotone" />
      <p className="text-lg font-semibold">{t("Поверните телефон вертикально")}</p>
      <p className="text-sm text-white/70">
        {t("Приложение работает только в вертикальном положении")}
      </p>
    </div>
  );
}
