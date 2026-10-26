import { createContext, useContext } from "react";

/**
 * id контрола, который раздаёт FormField (ui/form-field.tsx). Отдельным модулем:
 * его читают Input/Textarea/SelectTrigger, и тянуть в них Checkbox/Switch из
 * form-field незачем.
 */
export const FieldIdContext = createContext<string | undefined>(undefined);

/** id контрола: явный пропс важнее того, что раздаёт FormField. */
export function useFieldId(id?: string) {
  const fromField = useContext(FieldIdContext);
  return id ?? fromField;
}

/**
 * Обязательность и пояснение поля для скринридера: FormField знает, что поле
 * обязательно (звёздочка у подписи — только для глаз, aria-hidden) и где его
 * `hint`. Атрибуты получает только контрол, чей id совпал с id поля, — второй
 * контрол внутри того же FormField их не наследует.
 */
export const FieldAriaContext = createContext<{
  id?: string;
  required?: boolean;
  describedBy?: string;
  invalid?: boolean;
}>({});

/** aria-required / aria-describedby / aria-invalid для контрола с id `fieldId`. */
export function useFieldAria(fieldId: string | undefined) {
  const ctx = useContext(FieldAriaContext);
  if (!fieldId || ctx.id !== fieldId) return {};
  return {
    "aria-required": ctx.required || undefined,
    "aria-describedby": ctx.describedBy,
    "aria-invalid": ctx.invalid || undefined,
  };
}
