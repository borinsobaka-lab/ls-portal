/**
 * Конфетти на успешную продажу. Библиотека (canvas-confetti) грузится
 * отдельным чанком в момент первого залпа — в основной бандл не попадает.
 * При системной настройке «меньше движения» залпа нет. Сбой загрузки чанка
 * (например, после выкладки) молча пропускаем: продажа уже сохранена.
 */
export function celebrateSale() {
  void import("canvas-confetti")
    .then(({ default: confetti }) => {
      // Брендовый розовый + палитра Kate (ai-gradient) + жёлтый «40».
      const colors = ["#f763fc", "#ec4899", "#a855f7", "#6366f1", "#06b6d4", "#ffe400"];
      const shared = { particleCount: 90, spread: 70, startVelocity: 55, colors };
      const opts = { disableForReducedMotion: true, zIndex: 1000 };
      // Два залпа из нижних углов навстречу друг другу.
      confetti({ ...shared, ...opts, angle: 60, origin: { x: 0, y: 0.9 } });
      confetti({ ...shared, ...opts, angle: 120, origin: { x: 1, y: 0.9 } });
    })
    .catch(() => {});
}
