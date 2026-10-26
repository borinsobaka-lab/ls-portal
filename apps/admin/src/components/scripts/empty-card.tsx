import type { ReactNode } from "react";

/**
 * Пустое состояние раздела и вкладок «Скриптов LS»: что здесь будет и откуда
 * оно берётся. Одна карточка на весь раздел — страница скриптов и вкладки
 * «Настроек скриптов». С `title` — заголовок и пояснение под ним, без него —
 * только пояснение.
 */
export function EmptyCard({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border bg-background p-8 text-center text-sm text-muted-foreground">
      {title && <p className="font-medium text-foreground">{title}</p>}
      {children && <p className={title ? "mt-1" : undefined}>{children}</p>}
    </div>
  );
}
