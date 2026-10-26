import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { requestStaffLoginCode } from "@/lib/auth.functions";
import { Button } from "@/components/ui/button";
import { CodeInput } from "@/components/ui/code-input";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { AuthPageSkeleton } from "@/components/page-skeletons";
import { safeRedirectPath } from "@/lib/auth-redirect";
import { PORTAL_TITLE } from "@/lib/brand";

export const Route = createFileRoute("/auth")({
  // Ключ — всегда, и undefined: без него роутер оставил бы исходное значение
  // из адреса (поиск родителя без validateSearch проходит насквозь).
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: safeRedirectPath(search.redirect),
  }),
  pendingComponent: AuthPageSkeleton,
  component: AuthPage,
});

type Step = "email" | "code";

const CODE_LENGTH = 6;

/**
 * Вход по 6-значному коду из письма: паролей у сотрудников нет
 * (db/migrations/…_staff_accounts.sql их стирает), доступ = доступ к рабочей почте.
 *
 * Код создаёт GoTrue, а письмо отправляет наш сервер (/api/auth-email), и только
 * сотрудникам — см. requestStaffLoginCode. В браузер код не приходит ни в каком
 * ответе: он есть лишь в письме. Введённый код живёт только в состоянии этой
 * формы — не в URL, не в localStorage, не в логах — и уходит прямо в GoTrue
 * (verifyOtp); после попытки поле очищается.
 */
function AuthPage() {
  const navigate = useNavigate();
  const back = safeRedirectPath(Route.useSearch().redirect);
  const requestCode = useServerFn(requestStaffLoginCode);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const codeFormRef = useRef<HTMLFormElement>(null);
  const [step, setStep] = useState<Step>("email");
  const [loading, setLoading] = useState(false);
  // Ошибка шага — под полем (FormField error), а не тостом: тост исчезает
  // и не связан с полем для скринридера. Сбрасывается при правке поля.
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Вошёл — туда, откуда прислали на вход (ссылка на статью), иначе на главную.
    const done = () => (back ? navigate({ href: back }) : navigate({ to: "/" }));
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) void done();
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      if (s) void done();
    });
    return () => sub.subscription.unsubscribe();
  }, [navigate, back]);

  const sendCode = async () => {
    setLoading(true);
    try {
      await requestCode({
        data: { email: email.trim(), redirectTo: `${window.location.origin}/` },
      });
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setLoading(false);
    }
  };

  const submitEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim().includes("@")) {
      setError("Укажите почту");
      return;
    }
    if (await sendCode()) {
      setCode("");
      setError(null);
      setStep("code");
    }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (code.length !== CODE_LENGTH) {
      setError(`Введите ${CODE_LENGTH} цифр из письма`);
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.verifyOtp({
        email: email.trim().toLowerCase(),
        token: code,
        type: "email",
      });
      // Успех ловит onAuthStateChange выше: переход на главную, а guard
      // проверит роль сотрудника.
      if (error) {
        setError(
          /rate limit|too many/i.test(error.message)
            ? "Слишком много попыток. Подождите несколько минут."
            : "Неверный или устаревший код. Проверьте письмо или запросите новый код.",
        );
      }
    } finally {
      // Код одноразовый — не держим его в форме ни после успеха, ни после ошибки.
      setCode("");
      setLoading(false);
    }
  };

  const resend = async () => {
    setError(null);
    if (await sendCode()) {
      setCode("");
      // Ответ одинаковый и при лимите отправки (auth.functions.ts) — не обещаем,
      // что письмо точно ушло и прежний код погас.
      toast.success(
        "Если у этой почты есть доступ к порталу, новый код отправлен — проверьте письмо",
      );
    }
  };

  // Белая карточка лежит на канве, как и всё в админке.
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">
            <h1>{PORTAL_TITLE}</h1>
          </CardTitle>
          <CardDescription>
            {step === "email"
              ? "Вход для сотрудников и партнёров Lady Stretch — по коду из письма"
              : "Введите код из письма"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {step === "email" ? (
            <form noValidate onSubmit={submitEmail} className="space-y-4">
              <FormField label="Электронная почта" required error={error}>
                <Input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setError(null);
                  }}
                />
              </FormField>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="animate-spin" />}
                Получить код для входа
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                Вход открыт сотрудникам и партнёрам — собственникам клубов, которым выдан доступ к
                порталу.
              </p>
            </form>
          ) : (
            <form ref={codeFormRef} noValidate onSubmit={submitCode} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Если у <span className="font-medium text-foreground">{email}</span> есть доступ к
                порталу, мы отправили на неё {CODE_LENGTH}-значный код. Код действует 1 час и
                работает один раз.
              </p>
              <FormField label="Код из письма" required error={error}>
                <CodeInput
                  length={CODE_LENGTH}
                  autoFocus
                  disabled={loading}
                  invalid={!!error}
                  value={code}
                  onChange={(v) => {
                    setCode(v);
                    setError(null);
                  }}
                  // Вставили код из письма — входим сразу, без «Войти».
                  onComplete={() => setTimeout(() => codeFormRef.current?.requestSubmit(), 0)}
                />
              </FormField>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="animate-spin" />}
                Войти
              </Button>
              <div className="flex items-center justify-between">
                <Button
                  variant="link"
                  size="inline"
                  onClick={() => {
                    setCode("");
                    setError(null);
                    setStep("email");
                  }}
                >
                  Другая почта
                </Button>
                <Button variant="link" size="inline" onClick={resend} disabled={loading}>
                  Отправить код ещё раз
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
