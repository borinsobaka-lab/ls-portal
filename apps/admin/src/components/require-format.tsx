import type { ReactNode } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";

import { AdminShell } from "@/components/admin-shell";
import { RoutePendingSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { useActiveStudio } from "@/hooks/use-studios";
import { STUDIO_FORMAT_LABEL, type StudioFormat } from "@/lib/studio-formats";

/**
 * Страница одного формата студий (STUDIO_FORMATS.md). Меню прячет пункт
 * чужого формата, но по прямой ссылке или после смены студии в шапке
 * страница может открыться — тогда заглушка со ссылкой на одноимённый
 * раздел формата активной студии (`other`). Без студии — сама страница: её
 * `RequireStudio` попросит выбрать студию.
 */
export function RequireFormat({
  format,
  title,
  other,
  children,
}: {
  format: StudioFormat;
  /** Заголовок страницы — для шапки заглушки. */
  title: string;
  /** Тот же раздел у другого формата: адрес по формату. */
  other?: Partial<Record<StudioFormat, LinkProps["to"]>>;
  children: ReactNode;
}) {
  const studioId = useActiveStudioId();
  const studio = useActiveStudio();
  if (!studioId) return <>{children}</>;
  // Студии ещё грузятся — не показываем страницу, которая может оказаться чужой.
  if (!studio) return <RoutePendingSkeleton />;
  if (studio.format === format) return <>{children}</>;

  const otherUrl = other?.[studio.format];
  return (
    <AdminShell title={title}>
      <div className="space-y-3 rounded-lg border bg-background p-8 text-center text-sm text-muted-foreground">
        <p>
          Этот раздел — для клубов формата «{STUDIO_FORMAT_LABEL[format]}». Клуб «{studio.name}» — «
          {STUDIO_FORMAT_LABEL[studio.format]}».
        </p>
        {otherUrl && (
          <Button asChild variant="outline">
            <Link to={otherUrl}>Открыть раздел этого клуба</Link>
          </Button>
        )}
      </div>
    </AdminShell>
  );
}
