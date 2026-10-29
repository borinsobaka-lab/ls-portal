#!/usr/bin/env python3
"""Установка агента синхронизации на сервер старого портала аналитики.

Запускается от root на их сервере (батник «Установить синхронизацию.bat»
копирует agent.py и install.py и запускает этот файл по SSH):

  python3 -I -B install.py              — установить или обновить
  python3 -I -B install.py --uninstall  — убрать агента

Ставит:
  /opt/lady-analytics-replica/agent.py         — агент (README.md рядом)
  /etc/lady-analytics-replica/agent.env        — адрес портала и ключ
  /var/lib/lady-analytics-replica/             — что уже отправлено
  lady-analytics-replica.service + .timer       — запуск раз в 2 минуты
  /usr/local/bin/lady-analytics-replica         — запуск руками (--status, --check)

Служба работает от пользователя старого портала (из lady-analytics.service,
обычно ladyportal) и видит файловую систему только на чтение, кроме своей
папки состояния: менять данные старого портала она не может.
"""
from __future__ import annotations

import getpass
import os
import pwd
import shutil
import subprocess
import sys
from pathlib import Path

APP_DIR = Path("/opt/lady-analytics-replica")
CONF_DIR = Path("/etc/lady-analytics-replica")
CONF = CONF_DIR / "agent.env"
STATE_DIR = Path("/var/lib/lady-analytics-replica")
UNIT = "lady-analytics-replica"
UNIT_DIR = Path("/etc/systemd/system")
WRAPPER = Path("/usr/local/bin/lady-analytics-replica")
PORTAL_SERVICE = "lady-analytics.service"
PORTAL_DB = "/opt/lady-analytics/portal.sqlite3"
HERE = Path(__file__).resolve().parent


def run(*cmd: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=check, text=True)


def service_user() -> str:
    out = subprocess.run(["systemctl", "show", "-p", "User", "--value", PORTAL_SERVICE],
                         capture_output=True, text=True).stdout.strip()
    user = out or "ladyportal"
    try:
        pwd.getpwnam(user)
    except KeyError:
        sys.exit(f"Нет пользователя {user} (служба {PORTAL_SERVICE}). Установка остановлена.")
    return user


def read_conf() -> dict[str, str]:
    cfg: dict[str, str] = {}
    if CONF.exists():
        for line in CONF.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip()
    return cfg


def ask_settings(old: dict[str, str]) -> dict[str, str]:
    if old.get("PORTAL_URL") and old.get("REPLICA_SECRET"):
        keep = input(f"Портал: {old['PORTAL_URL']}. Оставить текущие настройки? [Y/n] ").strip().lower()
        if keep in ("", "y", "yes", "д", "да"):
            return old
    while True:
        url = input("Адрес портала (например https://portal.lady-stretching.ru): ").strip().rstrip("/")
        if url.startswith("https://") and "." in url:
            break
        print("Нужен адрес вида https://… — тот, где открывается портал.")
    while True:
        secret = getpass.getpass("Ключ синхронизации (ANALYTICS_REPLICA_SECRET из Coolify, ввод скрыт): ").strip()
        if len(secret) >= 32:
            break
        print("Ключ — не короче 32 символов. Его задают в Coolify у портала.")
    cfg = dict(old)
    cfg.update({"PORTAL_URL": url, "REPLICA_SECRET": secret})
    cfg.setdefault("PORTAL_DB", PORTAL_DB)
    cfg.setdefault("STATE_DIR", str(STATE_DIR))
    return cfg


def write_conf(cfg: dict[str, str], user: str):
    CONF_DIR.mkdir(parents=True, exist_ok=True)
    order = ["PORTAL_URL", "REPLICA_SECRET", "PORTAL_DB", "STATE_DIR", "MODULES"]
    lines = ["# Агент синхронизации старого портала аналитики с порталом (agent.py)."]
    lines += [f"{k}={cfg[k]}" for k in order if k in cfg]
    lines += [f"{k}={v}" for k, v in cfg.items() if k not in order]
    CONF.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chown(CONF, 0, pwd.getpwnam(user).pw_gid)
    os.chmod(CONF, 0o640)


def write_units(user: str):
    (UNIT_DIR / f"{UNIT}.service").write_text(f"""[Unit]
Description=Lady Stretch: синхронизация аналитики с порталом
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User={user}
ExecStart=/usr/bin/python3 -I -B {APP_DIR}/agent.py --config {CONF}
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=30min
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths={STATE_DIR}
""", encoding="utf-8")
    (UNIT_DIR / f"{UNIT}.timer").write_text(f"""[Unit]
Description=Lady Stretch: синхронизация аналитики с порталом каждые 2 минуты

[Timer]
OnBootSec=3min
OnUnitInactiveSec=2min
AccuracySec=15s

[Install]
WantedBy=timers.target
""", encoding="utf-8")
    WRAPPER.write_text(f"""#!/bin/sh
# Агент синхронизации руками: lady-analytics-replica --status | --check | --reset <таблица>
exec runuser -u {user} -- /usr/bin/python3 -I -B {APP_DIR}/agent.py --config {CONF} "$@"
""", encoding="utf-8")
    os.chmod(WRAPPER, 0o755)


def install():
    user = service_user()
    if not Path(PORTAL_DB).exists():
        sys.exit(f"Нет базы {PORTAL_DB}. Это сервер старого портала аналитики? Установка остановлена.")
    cfg = ask_settings(read_conf())

    APP_DIR.mkdir(parents=True, exist_ok=True)
    for name in ("agent.py", "install.py", "README.md"):
        if (HERE / name).exists() and (HERE / name).resolve() != (APP_DIR / name).resolve():
            shutil.copy2(HERE / name, APP_DIR / name)
    os.chmod(APP_DIR / "agent.py", 0o755)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    pw = pwd.getpwnam(user)
    os.chown(STATE_DIR, pw.pw_uid, pw.pw_gid)
    os.chmod(STATE_DIR, 0o700)
    for f in STATE_DIR.iterdir():
        os.chown(f, pw.pw_uid, pw.pw_gid)
    write_conf(cfg, user)
    write_units(user)

    run("systemctl", "daemon-reload")
    print("\nПроверка связи с порталом…")
    if subprocess.run([str(WRAPPER), "--check"]).returncode != 0:
        sys.exit("Портал не принял проверку — таймер не включён. Проверьте адрес и ключ "
                 "и запустите установку ещё раз.")
    run("systemctl", "enable", "--now", f"{UNIT}.timer")
    print("\nПервая отправка (может занять пару минут)…")
    run("systemctl", "start", f"{UNIT}.service", check=False)
    subprocess.run([str(WRAPPER), "--status"])
    print(f"\nГотово. Агент отправляет изменения каждые 2 минуты (таймер {UNIT}.timer).")
    print("Состояние: lady-analytics-replica --status; журнал: "
          f"journalctl -u {UNIT}.service -n 50")


def uninstall():
    run("systemctl", "disable", "--now", f"{UNIT}.timer", check=False)
    run("systemctl", "stop", f"{UNIT}.service", check=False)
    for p in (UNIT_DIR / f"{UNIT}.service", UNIT_DIR / f"{UNIT}.timer", WRAPPER):
        p.unlink(missing_ok=True)
    run("systemctl", "daemon-reload", check=False)
    for d in (APP_DIR, CONF_DIR, STATE_DIR):
        shutil.rmtree(d, ignore_errors=True)
    print("Агент синхронизации убран. Старый портал не затронут.")


def main():
    if os.geteuid() != 0:
        sys.exit("Запустите от root.")
    if "--uninstall" in sys.argv[1:]:
        uninstall()
    else:
        install()


if __name__ == "__main__":
    main()
