import { createFileRoute } from "@tanstack/react-router";

import { ShowcasePage, type ShowcaseConfig } from "@/components/showcase-page";
import { ServicesPageSkeleton } from "@/components/page-skeletons";

const SERVICES: ShowcaseConfig = {
  table: "services",
  bucket: "services",
  title: "Услуги",
  texts: {
    loadError: "Не удалось загрузить услуги",
    deleteTitle: "Удалить услугу?",
    deleted: "Услуга удалена",
    add: "Добавить услугу",
    empty: "Пока нет услуг. Нажмите «Добавить услугу».",
    added: "Услуга добавлена",
    updated: "Услуга обновлена",
    createTitle: "Новая услуга",
    editTitle: "Редактировать услугу",
    dialogDescription: "Услуга отображается в мобильном приложении.",
    fullTitlePlaceholder: "Заголовок на странице услуги",
    fullTextPlaceholder: "Текст услуги",
    buttonHint:
      "Если оба поля заполнены — в мобильном приложении под услугой появится кнопка-ссылка.",
    buttonPlaceholder: "Например: Записаться",
  },
  descriptionWidth: "320px",
  requireButtonPair: true,
};

export const Route = createFileRoute("/_authenticated/services")({
  head: () => ({ meta: [{ title: "Услуги — Base40 Admin" }] }),
  pendingComponent: ServicesPageSkeleton,
  component: () => <ShowcasePage config={SERVICES} />,
});
