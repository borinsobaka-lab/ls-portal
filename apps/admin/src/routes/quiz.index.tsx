import { createFileRoute } from "@tanstack/react-router";

import { QuizLandingPage } from "@/components/analytics/quiz/quiz-landing";
import quizCss from "@/components/analytics/quiz/quiz-landing.css?url";
import { QuizLandingSkeleton } from "@/components/page-skeletons";
import { QUIZ_HEAD } from "@/lib/analytics/quiz/rules";

/** Квиз-лендинг без города в адресе — город по умолчанию (их «/»). */
export const Route = createFileRoute("/quiz/")({
  head: () => ({
    meta: [{ title: QUIZ_HEAD.title }, { name: "description", content: QUIZ_HEAD.description }],
    links: [{ rel: "stylesheet", href: quizCss }],
  }),
  pendingComponent: QuizLandingSkeleton,
  component: () => <QuizLandingPage slug="" />,
});
