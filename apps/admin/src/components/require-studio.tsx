import type { ReactNode } from "react";

/** Содержимое раздела — только когда в шапке выбрана студия. */
export function RequireStudio({
  studioId,
  children,
}: {
  studioId: string | null;
  children: ReactNode;
}) {
  if (studioId) return <>{children}</>;
  return (
    <div className="rounded-lg border bg-background p-8 text-center text-sm text-muted-foreground">
      Сначала выберите клуб: справа в шапке, на телефоне — внизу меню.
    </div>
  );
}
