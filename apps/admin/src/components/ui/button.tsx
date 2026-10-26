import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Кнопка админки — всегда «пилюля» (rounded-full; иконка-кнопка — круг):
 * решение владельца 2026-10-11. Поля ввода и фильтры, наоборот,
 * прямоугольные (rounded-md, field-styles.ts) — по форме сразу видно, что
 * нажимается, а что заполняется. Скругление, высоту и отступы на месте не
 * задаём: нужен другой вид — вариант или размер здесь. Правила —
 * .interface-design/system.md, «Контролы».
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        // Подтверждение денег/успеха («Отметить как выплачено»).
        success: "bg-emerald-700 text-white hover:bg-emerald-800",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        // Заметное тихое действие: «Сбросить» при применённых фильтрах —
        // светло-красная заливка, красные текст и крестик (решение владельца
        // 2026-10-15; было оранжевой).
        attention: "bg-destructive/10 text-destructive hover:bg-destructive/15",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        // Мелкие действия внутри карточек и списков, не фильтры и не формы.
        sm: "h-9 px-3",
        // Отметки в строке списка (посещение в окне занятия): ниже sm, чтобы
        // строка клиента оставалась в одну высоту текста.
        xs: "h-7 px-2.5 text-xs [&_svg]:size-3.5",
        // Главное действие во всю ширину карточки; плавающие действия
        // страницы (FloatingActions) — этого же размера.
        lg: "h-12 px-6 text-[0.9375rem] [&_svg]:size-5",
        icon: "size-10",
        // Маленькая иконка-кнопка внутри строк и карточек (удалить пункт,
        // переставить) — вместо разрозненных h-6/h-7/h-8 на месте.
        "icon-sm": "size-8",
        // Ссылка-действие под полем («Добавить ещё номер», «Новый клиент»):
        // только с variant="link", без высоты и отступов кнопки.
        inline: "h-auto px-0 py-0.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        // По умолчанию кнопка — НЕ отправка формы: диалоги обёрнуты в <form>
        // (Enter = сохранить), и любая вспомогательная кнопка внутри («+»,
        // «Загрузить», «Сегодня») иначе отправляла бы форму. Отправляющей
        // кнопке type="submit" пишем явно.
        type={asChild ? type : (type ?? "button")}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
