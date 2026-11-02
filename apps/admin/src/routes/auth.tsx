import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { requestStaffLoginCode, signInWithLogin, type LoginResult } from "@/lib/auth.functions";
import { Button } from "@/components/ui/button";
import { CodeInput } from "@/components/ui/code-input";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
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
type Method = "login" | "email";

const CODE_LENGTH = 6;

/** Тексты отказов (решение владельца 2026-11-01: подсказать второй способ). */
const NOT_FOUND = {
  login: "Такой пользователь не найден. Попробуйте авторизоваться по почте.",
  email: "Почта не найдена. Попробуйте войти по логину и паролю с Platrum.",
};

function failureText(method: Method, res: Exclude<LoginResult, { ok: true }>): string {
  switch (res.reason) {
    case "not_found":
      return NOT_FOUND[method];
    case "wrong_password":
      return "Неверный пароль.";
    case "locked":
      return `Слишком много неверных паролей. Попробуйте через ${res.minutes} мин.`;
    case "too_many":
      return "Слишком много попыток. Подождите несколько минут.";
    case "no_access":
      return "У этого пользователя нет доступа к порталу. Обратитесь к администратору.";
  }
}

/**
 * Два способа входа (решение владельца 2026-11-01), переключатель вверху
 * карточки: «Логин и пароль» Platrum (по умолчанию — signInWithLogin,
 * db/migrations/2026-11-01_zz_portal_logins.sql) и «Почта» — 6-значный код
 * из письма. Пароля в GoTrue у сотрудников нет (…_staff_accounts.sql их
 * стирает): пару логин + пароль проверяет сервер портала и отдаёт сессию.
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
  const loginFn = useServerFn(signInWithLogin);
  const [method, setMethod] = useState<Method>("login");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const codeFormRef = useRef<HTMLFormElement>(null);
  const [step, setStep] = useState<Step>("email");
  const [loading, setLoading] = useState(false);
  // Ошибка шага — под полем (FormField error), а не тостом: тост исчезает
  // и не связан с полем для скринридера. Сбрасывается при правке поля.
  const [error, setError] = useState<string | null>(null);
  // У входа по логину ошибка — под паролем только при неверном пароле или пустом поле.
  const [errorAtPassword, setErrorAtPassword] = useState(false);

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
      const res = await requestCode({
        data: { email: email.trim(), redirectTo: `${window.location.origin}/` },
      });
      if (!res.ok) {
        setError(failureText("email", res));
        return false;
      }
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setLoading(false);
    }
  };

  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setErrorAtPassword(false);
    if (!login.trim()) {
      setError("Укажите логин");
      return;
    }
    if (!password) {
      setErrorAtPassword(true);
      setError("Укажите пароль");
      return;
    }
    setLoading(true);
    try {
      const res = await loginFn({ data: { login: login.trim(), password } });
      if (!res.ok) {
        setErrorAtPassword(res.reason === "wrong_password");
        setError(failureText("login", res));
        if (res.reason === "wrong_password") setPassword("");
        return;
      }
      if ("access_token" in res) {
        // Успех ловит onAuthStateChange выше: переход, guard проверит роль.
        const { error } = await supabase.auth.setSession({
          access_token: res.access_token,
          refresh_token: res.refresh_token,
        });
        if (error) setError("Не удалось войти. Попробуйте ещё раз.");
      }
    } catch (err) {
      setErrorAtPassword(false);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const switchMethod = (m: Method) => {
    setMethod(m);
    setError(null);
    setStep("email");
    setCode("");
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
      // Ответ «отправлено» и при лимите отправки (auth.functions.ts) — не
      // обещаем, что прежний код погас.
      toast.success("Новый код отправлен — проверьте письмо");
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
            {method === "login"
              ? "Вход для сотрудников и партнёров — по логину и паролю из Platrum"
              : step === "email"
                ? "Вход для сотрудников и партнёров — по коду из письма на почту, которая служит логином в Битрикс24"
                : "Введите код из письма"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {step === "email" && (
            <SegmentedControl
              aria-label="Способ входа"
              fullWidth
              value={method}
              onChange={switchMethod}
              options={[
                { value: "login", label: "Логин и пароль" },
                { value: "email", label: "Почта" },
              ]}
            />
          )}
          {method === "login" ? (
            <form noValidate onSubmit={submitLogin} className="space-y-4">
              <FormField label="Логин" required error={errorAtPassword ? null : error}>
                <Input
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={login}
                  onChange={(e) => {
                    setLogin(e.target.value);
                    setError(null);
                  }}
                />
              </FormField>
              <FormField label="Пароль" required error={errorAtPassword ? error : null}>
                <Input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                />
              </FormField>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="animate-spin" />}
                Войти
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                Логин и пароль — те же, что в Platrum. Нет логина — войдите по почте.
              </p>
            </form>
          ) : step === "email" ? (
            <form noValidate onSubmit={submitEmail} className="space-y-4">
              <FormField label="Почта — логин в Битрикс24" required error={error}>
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
                Укажите почту, с которой входите в Битрикс24, — на неё придёт 6-значный код. Вход
                открыт сотрудникам и партнёрам — собственникам клубов, которым выдан доступ к
                порталу.
              </p>
            </form>
          ) : (
            <form ref={codeFormRef} noValidate onSubmit={submitCode} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Мы отправили {CODE_LENGTH}-значный код на{" "}
                <span className="font-medium text-foreground">{email}</span>. Код действует 1 час и
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
