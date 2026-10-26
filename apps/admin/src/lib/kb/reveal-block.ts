/**
 * Блок статьи по id — с раскрытием свёрнутых спойлеров и сворачиваемых
 * заголовков над ним. Вложенное в свёрнутый блок BlockNote прячет CSS
 * (`display: none`), а оглавление и ссылки `#id` ведут и туда: без
 * раскрытия переход ничего не показывал — «заголовок есть в содержании, но
 * нет в статье» (замечание тестирования 2026-10-25). Состояние «раскрыт»
 * BlockNote хранит сам (localStorage `toggle-<id>`), поэтому раскрываем его
 * же кнопкой.
 */
export function revealKbBlock(root: ParentNode | null | undefined, id: string): HTMLElement | null {
  const el = root?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
  if (!root || !el) return null;
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    '.bn-toggle-button[aria-expanded="false"]',
  )) {
    const owner = button.closest<HTMLElement>("[data-id]");
    if (owner && owner.getAttribute("data-id") !== id && owner.contains(el)) button.click();
  }
  return el;
}

/** Блок виден на странице (не внутри свёрнутого). */
export function kbBlockShown(el: Element): boolean {
  return el.getClientRects().length > 0;
}
