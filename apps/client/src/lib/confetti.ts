import confetti from "canvas-confetti";

/** Салют: завершение анкеты, вход в приложение, покупка абонемента. */
export function fireConfetti() {
  const fire = (opts: confetti.Options) =>
    confetti({ particleCount: 80, spread: 70, startVelocity: 45, ...opts });
  fire({ origin: { x: 0.2, y: 0.7 }, angle: 60 });
  fire({ origin: { x: 0.8, y: 0.7 }, angle: 120 });
  setTimeout(() => fire({ origin: { x: 0.5, y: 0.6 }, spread: 100 }), 200);
}

// Салют на главной после входа по коду и после анкеты (решение владельца
// 2026-10-12). Экран входа и анкета только ставят флаг, а стреляет главная,
// когда откроется: между ними — проверка анкеты (новый клиент уходит в неё,
// и салют ждёт её конца). sessionStorage — флаг не переживает закрытие
// приложения и не стреляет при следующем запуске.
const HOME_CONFETTI_KEY = "base40.homeConfetti";

export function queueHomeConfetti() {
  try {
    window.sessionStorage.setItem(HOME_CONFETTI_KEY, "1");
  } catch {
    // приватный режим — без салюта
  }
}

export function cancelHomeConfetti() {
  try {
    window.sessionStorage.removeItem(HOME_CONFETTI_KEY);
  } catch {
    // нечего снимать
  }
}

/** Главная: салют, если он поставлен в очередь; флаг снимается сразу. */
export function fireQueuedHomeConfetti() {
  try {
    if (window.sessionStorage.getItem(HOME_CONFETTI_KEY) !== "1") return;
    window.sessionStorage.removeItem(HOME_CONFETTI_KEY);
  } catch {
    return;
  }
  // Даём главной отрисоваться — салют поверх готового экрана.
  window.setTimeout(fireConfetti, 300);
}
