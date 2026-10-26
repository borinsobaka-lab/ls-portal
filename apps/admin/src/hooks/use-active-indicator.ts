import * as React from "react";

// На сервере useLayoutEffect ругается в консоль; там плашку всё равно не меряем.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

export type Indicator = { left: number; top: number; width: number; height: number };

/**
 * Плашка под активным элементом группы (табы, сегменты): при переключении она
 * переезжает к новому элементу (transform + width), а не перекрашивает
 * кнопки. Положение меряем по DOM: смену выбора ловит MutationObserver на
 * атрибуте `attribute`, смену размеров (шрифт догрузился, ширина диалога) —
 * ResizeObserver. Первая отрисовка без анимации — плашка сразу на месте.
 *
 * `items` — селектор элементов группы, `active` — селектор активного.
 *
 * `memoryKey` — для групп, которые заводятся заново при смене страницы
 * (вкладки баз знаний в шапке: шапка — часть страницы): последнее
 * положение плашки запоминается, и новая группа сначала рисует её там, а
 * потом переезжает к активному — как у табов внутри одной страницы.
 */
const remembered = new Map<string, Indicator>();

export function useActiveIndicator(
  listRef: React.RefObject<HTMLElement | null>,
  items: string,
  active: string,
  attribute: string,
  memoryKey?: string,
) {
  const [indicator, setIndicator] = React.useState<Indicator | null>(null);

  useIsomorphicLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const measure = (): Indicator | null => {
      const el = list.querySelector<HTMLElement>(active);
      return el
        ? { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }
        : null;
    };
    // Пока плашка стоит на прежнем месте, замеры (ResizeObserver зовёт сразу
    // при подписке) не трогают её — иначе переезд не успел бы отрисоваться.
    let settled = true;
    const update = () => {
      if (!settled) return;
      const next = measure();
      if (next && memoryKey) remembered.set(memoryKey, next);
      setIndicator(next);
    };

    // Группа заведена заново: плашка — с прежнего места, переезд — со
    // следующего кадра (сначала прежнее положение должно отрисоваться).
    let frame = 0;
    const from = memoryKey ? remembered.get(memoryKey) : undefined;
    const to = measure();
    if (from && to && (from.left !== to.left || from.width !== to.width)) {
      settled = false;
      setIndicator(from);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          settled = true;
          update();
        });
      });
    } else {
      update();
    }

    const resize = new ResizeObserver(update);
    const observeItems = () => list.querySelectorAll(items).forEach((el) => resize.observe(el));
    resize.observe(list);
    observeItems();

    const mutation = new MutationObserver(() => {
      observeItems();
      update();
    });
    mutation.observe(list, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [attribute],
    });

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
    };
  }, [items, active, attribute, memoryKey]);

  return indicator;
}
