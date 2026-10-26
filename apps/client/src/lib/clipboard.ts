/** Копирует текст; false — не вышло (пусть человек скопирует вручную). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Встроенные браузеры без Clipboard API — через выделение во временном поле.
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      // 16px — иначе iOS увеличивает страницу при выделении.
      area.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px;";
      document.body.appendChild(area);
      area.select();
      area.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
