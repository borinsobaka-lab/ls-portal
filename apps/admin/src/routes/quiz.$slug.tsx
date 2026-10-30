import { createFileRoute } from "@tanstack/react-router";

import { QuizLandingPage } from "@/components/analytics/quiz/quiz-landing";
import quizCss from "@/components/analytics/quiz/quiz-landing.css?url";
import { QuizLandingSkeleton } from "@/components/page-skeletons";
import { QUIZ_HEAD } from "@/lib/analytics/quiz/rules";

/**
 * Квиз-лендинг города — их quiz.lady-stretching.ru/<город> (без входа и без
 * каркаса портала; города — «Аналитика» → «Квиз-лендинги»).
 */
export const Route = createFileRoute("/quiz/$slug")({
  head: () => ({
    meta: [{ title: QUIZ_HEAD.title }, { name: "description", content: QUIZ_HEAD.description }],
    links: [{ rel: "stylesheet", href: quizCss }],
  }),
  pendingComponent: QuizLandingSkeleton,
  component: QuizCityPage,
});

function QuizCityPage() {
  const { slug } = Route.useParams();
  return <QuizLandingPage slug={slug} />;
}
