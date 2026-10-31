"""Помощник входа FitBase для «Аналитики» портала (их automatic-basis/authorize.py).

Вход в FitBase защищён CAPTCHA, поэтому входит владелец сам — в отдельном окне
браузера на своём компьютере. После входа помощник берёт cookies FitBase этого
окна и передаёт их порталу с одноразовым кодом со страницы «Интеграция FitBase»
→ «Основания записей». Пароль остаётся в FitBase; cookies не печатаются.

    python fitbase_session.py                 — спросит код и откроет окно входа
    python fitbase_session.py --save FILE     — сохранить сессию в файл (вставить
                                                на портале вручную), без кода

Нужен Python 3.9+ и пакет playwright; браузер — Chrome или Edge компьютера
(иначе Chromium из `python -m playwright install chromium`).
"""
import argparse
import base64
import json
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

FITBASE = re.compile(r"https://[a-z0-9-]+\.fitbase\.io")
# Адрес портала: https, для проверки на своём компьютере — http://127.0.0.1 / localhost.
PORTAL = re.compile(r"(https://[A-Za-z0-9.-]+(:\d+)?|http://(127\.0\.0\.1|localhost)(:\d+)?)")
DASHBOARDS = ("/site/dashboard-new", "/site/dashboard", "/client-schedule/index")


class Stop(Exception):
    pass


def decode_code(code):
    """Код портала: base64url JSON {u: адрес портала, t: ключ, o: адрес FitBase}."""
    raw = code.strip()
    try:
        data = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise Stop("Код не распознан — скопируйте его со страницы портала целиком.")
    if not isinstance(data, dict) or set(data) != {"u", "t", "o"}:
        raise Stop("Код не распознан — скопируйте его со страницы портала целиком.")
    portal, token, origin = data["u"], data["t"], data["o"]
    if not (isinstance(portal, str) and PORTAL.fullmatch(portal)):
        raise Stop("В коде неверный адрес портала.")
    if not (isinstance(origin, str) and FITBASE.fullmatch(origin)):
        raise Stop("В коде неверный адрес FitBase.")
    if not (isinstance(token, str) and re.fullmatch(r"[A-Za-z0-9_-]{20,100}", token)):
        raise Stop("Код не распознан — скопируйте его со страницы портала целиком.")
    return portal, token, origin


def logged_in(url, origin, has_login_form, has_club_picker):
    """Их authenticated_page: страница FitBase после входа (не форма входа)."""
    if has_login_form:
        return False
    p = urlparse(url)
    if p.scheme + "://" + p.netloc != origin:
        return False
    if p.path.rstrip("/") in DASHBOARDS:
        return True
    if p.path.startswith("/site/login"):
        return False
    return has_club_picker


def authenticated_page(context, origin):
    for page in reversed(context.pages):
        if page.is_closed():
            continue
        # Обращение к странице заодно доставляет события переходов.
        login = page.locator("form#login-form").count() > 0
        picker = page.locator('select[name="club-picker"], form[action="/site/logout"]').count() > 0
        if logged_in(page.url, origin, login, picker):
            return page
    return None


def session_payload(origin, cookies):
    """Только то, что нужно порталу: адрес FitBase и cookies его домена."""
    host = urlparse(origin).hostname
    keep = []
    for c in cookies:
        domain = str(c.get("domain", ""))
        if not (host == domain.lstrip(".") or (domain.startswith(".") and host.endswith(domain))):
            continue
        keep.append({
            "name": c["name"],
            "value": c["value"],
            "domain": domain,
            "path": c.get("path", "/"),
            "secure": bool(c.get("secure", True)),
            "expires": c.get("expires", -1),
            "httpOnly": bool(c.get("httpOnly", False)),
        })
    if not keep:
        raise Stop("Браузер не отдал cookies FitBase — войдите ещё раз.")
    if len(keep) > 100:
        raise Stop("Слишком много cookies FitBase — закройте лишние вкладки и войдите заново.")
    return {"origin": origin, "cookies": keep}


def send(portal, token, payload, opener=urlopen):
    req = Request(
        portal + "/api/analytics/fitbase/session",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
        method="POST",
    )
    try:
        with opener(req, timeout=120) as res:
            body = json.loads(res.read(100000).decode("utf-8"))
    except HTTPError as e:
        try:
            message = json.loads(e.read(100000).decode("utf-8")).get("error")
        except (ValueError, UnicodeDecodeError, AttributeError):
            message = None
        raise Stop("Портал не принял сессию: " + (message or "ошибка " + str(e.code) + "."))
    except URLError:
        raise Stop("Портал не отвечает — проверьте интернет и попробуйте ещё раз.")
    return int(body.get("studios", 0))


def launch(p):
    """Chrome компьютера, иначе Edge, иначе Chromium Playwright."""
    for channel in ("chrome", "msedge", None):
        try:
            if channel:
                return p.chromium.launch(channel=channel, headless=False)
            return p.chromium.launch(headless=False)
        except Exception:
            continue
    raise Stop("Не нашёлся браузер: установите Google Chrome или выполните "
               "«python -m playwright install chromium».")


def browser_session(origin):
    from playwright.sync_api import sync_playwright, TimeoutError as NavigationTimeout

    print("Войдите в FitBase в открывшемся окне сами (CAPTCHA — тоже вы).")
    print("Оставьте «Запомнить меня». Пароль уходит только в FitBase.")
    with sync_playwright() as p:
        browser = launch(p)
        context = browser.new_context()
        page = context.new_page()
        try:
            page.goto(origin + "/site/login", wait_until="domcontentloaded", timeout=30000)
        except NavigationTimeout:
            print("Страница грузится долго — окно остаётся открытым, войдите в нём.")
        while True:
            input("Когда откроется FitBase после входа, вернитесь сюда и нажмите Enter: ")
            if not [x for x in context.pages if not x.is_closed()]:
                raise Stop("Окно браузера закрыто — запустите помощника заново.")
            if authenticated_page(context, origin) is not None:
                break
            print("Вход ещё не виден: дождитесь главной страницы FitBase в окне помощника.")
        payload = session_payload(origin, context.cookies([origin]))
        browser.close()
        return payload


def main(argv=None):
    ap = argparse.ArgumentParser(description="Помощник входа FitBase для портала.")
    ap.add_argument("--code", help="код со страницы портала (иначе спросит)")
    ap.add_argument("--save", metavar="FILE", help="сохранить сессию в файл вместо отправки")
    ap.add_argument("--origin", help="адрес FitBase для --save, например https://ladyjump.fitbase.io")
    args = ap.parse_args(argv)
    if args.save:
        origin = args.origin or input("Адрес FitBase (https://….fitbase.io): ").strip()
        if not FITBASE.fullmatch(origin):
            raise Stop("Неверный адрес FitBase.")
        payload = browser_session(origin)
        with open(args.save, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=True)
        print("Сессия сохранена в " + args.save + ". Вставьте содержимое файла на портале "
              "(«Вставить сессию вручную») и удалите файл.")
        return 0
    code = args.code or input("Вставьте код со страницы портала и нажмите Enter: ")
    portal, token, origin = decode_code(code)
    payload = browser_session(origin)
    print("Передаю сессию порталу…")
    studios = send(portal, token, payload)
    print("Готово: портал проверил доступ ко всем клубам студий (" + str(studios) + "). "
          "Окно можно закрыть; дальше портал собирает основания сам.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Stop as e:
        print(str(e))
        sys.exit(1)
    except KeyboardInterrupt:
        print("Остановлено.")
        sys.exit(1)
