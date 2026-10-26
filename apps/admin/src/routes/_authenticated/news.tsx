import { createFileRoute } from "@tanstack/react-router";

import { ShowcasePage, type ShowcaseConfig } from "@/components/showcase-page";
import { NewsPageSkeleton } from "@/components/page-skeletons";

const NEWS: ShowcaseConfig = {
  table: "news",
  bucket: "news",
  title: "Новости",
  texts: {
    loadError: "Не удалось загрузить новости",
    deleteTitle: "Удалить новость?",
    deleted: "Новость удалена",
    add: "Добавить новость",
    empty: "Пока нет новостей. Нажмите «Добавить новость».",
    added: "Новость добавлена",
    updated: "Новость обновлена",
    createTitle: "Новая новость",
    editTitle: "Редактировать новость",
    dialogDescription: "Новость отображается в мобильном приложении.",
    fullTitlePlaceholder: "Заголовок на странице новости",
    fullTextPlaceholder: "Текст новости",
    buttonHint:
      "Если оба поля заполнены — в мобильном приложении под новостью появится кнопка-ссылка.",
    buttonPlaceholder: "Например: Подробнее",
  },
  descriptionWidth: "360px",
  // Исторически у новостей кнопку можно заполнить наполовину (приложение её
  // тогда не показывает); у услуг — нельзя. Выровнять — решение владельца.
  requireButtonPair: false,
};

export const Route = createFileRoute("/_authenticated/news")({
  head: () => ({ meta: [{ title: "Новости — Lady Stretch" }] }),
  pendingComponent: NewsPageSkeleton,
  component: () => <ShowcasePage config={NEWS} />,
});
