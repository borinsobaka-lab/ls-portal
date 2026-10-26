/**
 * Сбрасывает прокрутку окна и всех контейнеров страницы ([data-page-scroll],
 * см. PageShell). Общая для корневого layout и нижней навигации.
 */
export function resetPageScrollPosition() {
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  document.querySelectorAll<HTMLElement>("[data-page-scroll]").forEach((element) => {
    element.scrollTop = 0;
    element.scrollLeft = 0;
  });
}
