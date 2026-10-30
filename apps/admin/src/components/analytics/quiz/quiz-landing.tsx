import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { QuizLandingSkeleton } from "@/components/page-skeletons";
import { quizLandingQuery, type QuizLanding } from "@/lib/analytics/quiz/data";
import {
  QUIZ_LANDING_TEXT,
  QUIZ_QUESTIONS,
  quizPayload,
  quizPhoneHref,
  quizResultText,
  quizUtmFromSearch,
  type QuizAnswers,
} from "@/lib/analytics/quiz/rules";

/** Куда лендинг шлёт заявку (их leadEndpoint /api/leads → /api/quiz/leads). */
const LEAD_ENDPOINT = "/api/analytics/quiz/leads";

/**
 * Квиз-лендинг Lady Stretch — их /opt/lady-quiz (index.html + app.js):
 * обложка, три вопроса, форма заявки, результат. Город — по адресу
 * /quiz/<город> (их citySlug), не найден — город по умолчанию. Вид и тексты —
 * их (quiz-landing.css), данные города — из «Аналитика» → «Квиз-лендинги».
 */
export function QuizLandingPage({ slug }: { slug: string }) {
  const { data, isPending, error, refetch, isRefetching } = useQuery(quizLandingQuery(slug));
  if (isPending) return <QuizLandingSkeleton />;
  if (error || !data) {
    return (
      <div className="quiz-page">
        <main className="quiz-shell">
          <section className="screen screen--active cover">
            <p className="eyebrow">Lady Stretch</p>
            <h2>{error ? "Не удалось открыть страницу" : "Тест пока недоступен"}</h2>
            <p className="lead">
              {error
                ? "Проверьте подключение к интернету и попробуйте ещё раз."
                : "Загляните чуть позже."}
            </p>
            {error && (
              <button
                className="button button--primary"
                type="button"
                disabled={isRefetching}
                onClick={() => void refetch()}
              >
                Попробовать снова
              </button>
            )}
          </section>
        </main>
      </div>
    );
  }
  return <Quiz config={data} slug={slug || data.slug} />;
}

function Quiz({ config, slug }: { config: QuizLanding; slug: string }) {
  const [screen, setScreen] = useState(0);
  const [answers, setAnswers] = useState<QuizAnswers>({});
  // Поля формы живут дольше экрана: «Назад» с формы их не стирает (у них
  // экраны только прячутся).
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [formError, setFormError] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState("");
  const policy = useRef<HTMLDialogElement>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    document.title = `Подбор тренировок в Lady Stretch — ${config.city}`;
  }, [config.city]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const go = (index: number) => {
    setScreen(index);
    window.scrollTo(0, 0);
  };

  const choose = (index: number, key: keyof QuizAnswers, value: string) => {
    setAnswers((a) => ({ ...a, [key]: value }));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => go(index + 1), 140);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    setFormError("");
    if (!form.reportValidity()) return;
    if (!answers.pain || !answers.duration || !answers.barrier) {
      setFormError(QUIZ_LANDING_TEXT.incomplete);
      return;
    }
    const payload = quizPayload({
      name,
      phone,
      city: config.city,
      citySlug: slug,
      landingVersion: config.landing_version,
      landingPath: window.location.pathname,
      answers,
      utm: quizUtmFromSearch(window.location.search),
    });
    setSending(true);
    try {
      const res = await fetch(LEAD_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const response = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!res.ok || !response?.ok) throw new Error("lead endpoint");
      setResult(quizResultText(answers));
      go(5);
    } catch {
      setFormError(QUIZ_LANDING_TEXT.failed);
    } finally {
      setSending(false);
    }
  };

  const price = String(config.trial_price);
  const question = screen >= 1 && screen <= 3 ? QUIZ_QUESTIONS[screen - 1] : null;

  return (
    <div className="quiz-page">
      <main className="quiz-shell" aria-live="polite">
        {screen === 0 && (
          <section className="screen screen--active cover">
            <div className="cover__glow" />
            <p className="eyebrow">Lady Stretch · {config.city}</p>
            <h1>Какое направление тренировок вам подойдёт?</h1>
            <p className="lead">
              Пройдите тест за 30 секунд — узнаете своё направление и заберёте пробное занятие за{" "}
              {price} ₽
            </p>
            <div className="result-teaser" aria-label="Возможные результаты теста">
              <p>Ваш результат — один из этих →</p>
              <div className="teaser-grid">
                <span>
                  Стройное
                  <br />
                  тело
                </span>
                <span>
                  Здоровая
                  <br />
                  спина
                </span>
                <span>
                  Энергия
                  <br />и тонус
                </span>
                <span>
                  Уверенность
                  <br />в себе
                </span>
              </div>
            </div>
            <div className="studio-facts">
              <p>
                <strong>Lady Stretch</strong> — фитнес-студия для женщин в городе {config.city}
              </p>
              <p>18+ направлений, мини-группы до 8 человек и внимание тренера каждой</p>
            </div>
            <p className="why">
              Ответьте на 3 вопроса — подберём направление под вашу цель, а не предложим всё подряд.
            </p>
            <button className="button button--primary" type="button" onClick={() => go(1)}>
              Узнать своё направление
            </button>
            <p className="micro">Уже прошли {config.completed_count} девушек</p>
          </section>
        )}

        {question && (
          <section key={question.key} className="screen screen--active question">
            <div className="progress">
              <span style={{ width: `${(screen / 3) * 100}%` }} />
            </div>
            <p className="progress__label">{screen} из 3</p>
            <button className="back" type="button" onClick={() => go(screen - 1)}>
              ← Назад
            </button>
            <h2>{question.title}</h2>
            <div className="answers">
              {question.options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => choose(screen, question.key, o.value)}
                >
                  {o.text}
                </button>
              ))}
            </div>
          </section>
        )}

        {screen === 4 && (
          <section className="screen screen--active form-screen">
            <button className="back" type="button" onClick={() => go(3)}>
              ← Назад
            </button>
            <p className="eyebrow">Последний шаг</p>
            <h2>Почти готово — куда отправить вашу рекомендацию?</h2>
            <form noValidate onSubmit={(e) => void submit(e)}>
              <label>
                Ваше имя
                <input
                  name="name"
                  autoComplete="name"
                  required
                  maxLength={80}
                  placeholder="Например, Анна"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                Телефон
                <input
                  name="phone"
                  autoComplete="tel"
                  required
                  inputMode="tel"
                  maxLength={30}
                  placeholder="+7 (___) ___-__-__"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </label>
              <label className="consent">
                <input
                  name="consent"
                  type="checkbox"
                  required
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  Соглашаюсь на обработку персональных данных и принимаю{" "}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => policy.current?.showModal()}
                  >
                    политику конфиденциальности
                  </button>
                  .
                </span>
              </label>
              <p className="form-error" role="alert">
                {formError}
              </p>
              <button className="button button--primary" type="submit" disabled={sending}>
                Получить рекомендацию + пробное за {price} ₽
              </button>
            </form>
            <p className="award">🏆 Лучшая фитнес-студия России — Russian Fitness Award</p>
          </section>
        )}

        {screen === 5 && (
          <section className="screen screen--active result">
            <div className="result__check">✓</div>
            <p className="eyebrow">Результат готов</p>
            <h2>Мы подобрали направление под вас</h2>
            <p className="result__text">{result}</p>
            <div className="contact-card">
              <strong>Lady Stretch · {config.city}</strong>
              <div>
                {config.locations.map((l, i) => {
                  const href = l.phone_href || quizPhoneHref(l.phone_display);
                  return (
                    <div key={i} className="contact-location">
                      <span>{l.address}</span>
                      {l.landmark && <small>{l.landmark}</small>}
                      {l.phone_display && <a href={href || undefined}>{l.phone_display}</a>}
                    </div>
                  );
                })}
              </div>
            </div>
            <p className="micro">Администратор свяжется с вами, чтобы подобрать удобное время.</p>
          </section>
        )}
      </main>
      <dialog ref={policy}>
        <button
          className="dialog-close"
          type="button"
          aria-label="Закрыть"
          onClick={() => policy.current?.close()}
        >
          ×
        </button>
        <h2>Политика конфиденциальности</h2>
        <p>
          Оператор персональных данных: {config.operator_name}, ИНН {config.operator_inn}.
        </p>
        <p>
          Мы используем имя и номер телефона только для обработки заявки, отправки рекомендации и
          связи по пробному занятию. До публикации документ будет дополнен контактами оператора,
          сроками хранения и утверждённой редакцией.
        </p>
      </dialog>
    </div>
  );
}
