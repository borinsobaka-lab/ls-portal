// Вход без карточки клиента. Учётная запись может существовать, а карточки
// нет (заведена давно или карточку удалили на портале): тогда
// ensure_client_profile отвечает not_a_club_member
// (db/migrations/2026-10-12_client_account_wipe.sql), приложение выходит, а
// экран входа показывает «почта не найдена среди членов клуба».

const KEY = "base40.signin-refused";

export function isNotMemberError(error: { message?: string } | null | undefined): boolean {
  return !!error?.message?.includes("not_a_club_member");
}

export function markSignInRefused() {
  try {
    window.sessionStorage.setItem(KEY, "1");
  } catch {
    // приватный режим — экран входа откроется без пояснения
  }
}

/** Был ли отказ (флаг снимается при чтении). */
export function takeSignInRefused(): boolean {
  try {
    const refused = window.sessionStorage.getItem(KEY) === "1";
    window.sessionStorage.removeItem(KEY);
    return refused;
  } catch {
    return false;
  }
}
