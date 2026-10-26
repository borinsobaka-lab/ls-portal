import { IS_PACKAGES } from "@/lib/terms";

/**
 * Реквизиты политики конфиденциальности (components/privacy-policy.tsx,
 * экран /privacy). Политика — только у приложения Lady Stretch (пакетное,
 * решение владельца 2026-10-13); у подписочного (Base40) её нет — null, в
 * профиле остаётся прежняя строка «Правовые документы».
 */
export type PrivacyOperator = {
  /** ИП — как в реестре и в оферте студии (по-английски). */
  name: string;
  /** Идентификационный номер. */
  idCode: string;
  /** Студия, с клиентами которой ИП заключает оферту. */
  studio: string;
  address: string;
  phone: string;
};

export type PrivacyPolicyInfo = {
  /** Бренд в тексте политики. */
  brand: string;
  /**
   * Операторы данных — у каждой студии свой ИП (исполнитель по её оферте,
   * решение владельца 2026-10-13).
   */
  operators: PrivacyOperator[];
  /** Общая почта для запросов по персональным данным. */
  email: string;
  /** Дата вступления в силу текущей редакции, ISO (ГГГГ-ММ-ДД). */
  effectiveDate: string;
};

/**
 * Операторы и почта — из переменных сборки (в репозитории реквизитов нет):
 * VITE_PRIVACY_OPERATORS — JSON-массив PrivacyOperator, VITE_PRIVACY_EMAIL,
 * VITE_PRIVACY_EFFECTIVE_DATE (ГГГГ-ММ-ДД).
 */
function envOperators(): PrivacyOperator[] {
  try {
    const parsed: unknown = JSON.parse(import.meta.env.VITE_PRIVACY_OPERATORS || "[]");
    return Array.isArray(parsed) ? (parsed as PrivacyOperator[]) : [];
  } catch {
    return [];
  }
}

export const PRIVACY_POLICY_INFO: PrivacyPolicyInfo | null = IS_PACKAGES
  ? {
      brand: "Lady Stretch",
      operators: envOperators(),
      email: import.meta.env.VITE_PRIVACY_EMAIL || "privacy@example.com",
      effectiveDate: import.meta.env.VITE_PRIVACY_EFFECTIVE_DATE || "2026-10-15",
    }
  : null;
