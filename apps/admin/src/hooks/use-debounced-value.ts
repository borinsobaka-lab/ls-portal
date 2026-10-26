import { useEffect, useState } from "react";

/**
 * Возвращает значение с задержкой — нужно для полей поиска, которые теперь
 * ходят в БД: без задержки запрос уходил бы на каждое нажатие клавиши.
 */
export function useDebouncedValue<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
