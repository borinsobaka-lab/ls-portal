/**
 * Пользователи портала, роли и доступы — типы ответов базы
 * (db/migrations/2026-10-25_zzzzzzzzzzzz_access_roles.sql, ACCESS.md).
 */

export type PermScope = "studio" | "network";
export type PermBlock = "club" | "sections" | "knowledge" | "admin";

/** Право из каталога access_permissions. */
export type PermissionDef = {
  key: string;
  block: PermBlock;
  label: string;
  hint: string | null;
  scope: PermScope;
  /** Уровни: ['on'] — просто включено; иначе — выбор (view/edit, trainer/admin/owner). */
  levels: string[];
  /** kb_base — право на конкретную базу знаний (target_id; null — на все). */
  target: "kb_base" | null;
  sort_order: number;
};

export type RolePerm = { perm_key: string; target_id: string | null; level: string };

export type AccessRole = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  system_key: string | null;
  /** Права не меняются (суперадминистратор). */
  locked: boolean;
  sort_order: number;
  updated_at: string;
  permissions: RolePerm[];
  /** Назначений роли и людей, кому она сейчас действует. */
  assignments: number;
  users: number;
  /** Почему вызывающий не может выдать роль (без учёта клубов); null — может. */
  grant_problem: string | null;
};

export type SubjectType = "user" | "unit" | "position";
export type ScopeType = "all" | "brands" | "studios";
export type MemberRole = "head" | "deputy" | "member";
export type UserType = "hq" | "partner" | "studio" | "contractor" | "service";
export type UserStatus = "active" | "blocked";
export type Tier = "trainer" | "admin" | "owner";

export type Assignment = {
  id: string;
  role_id: string;
  subject_type: SubjectType;
  user_id: string | null;
  unit_id: string | null;
  position_id: string | null;
  unit_members: "all" | "heads";
  with_subunits: boolean;
  scope_type: ScopeType;
  scope_ids: string[];
  valid_from: string | null;
  valid_until: string | null;
  note: string | null;
  created_at: string;
  created_by: string | null;
  created_by_name?: string | null;
  /** Действует сейчас (срок). */
  active?: boolean;
};

/** Итог пересчёта прав (access_user_rights.effective). */
export type Effective = {
  active?: boolean;
  portal?: boolean;
  rights?: string[];
  /** Разделы рейки; null — все. */
  rails?: string[] | null;
  studios?: Record<string, { tier: Tier; sections: string[] | null }>;
  kb?: Record<string, "view" | "edit">;
  academy?: { create: boolean; review: boolean };
  manage?: { all: boolean; studios: string[] };
};

export type UserRoleRef = {
  assignment_id: string;
  role_id: string;
  subject_type: SubjectType;
  scope_type: ScopeType;
  scope_ids: string[];
  valid_until: string | null;
  personal: boolean;
};

/** Строка списка пользователей (access_users). */
export type PortalUserRow = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  user_type: UserType | null;
  position_id: string | null;
  status: UserStatus;
  access_until: string | null;
  note: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  /** Может войти в админку (активен и есть действующее назначение). */
  portal: boolean;
  /** Клубы с доступом к данным. */
  studio_ids: string[];
  units: { unit_id: string; member_role: MemberRole }[];
  /** Действующие роли (и через подразделение и должность). */
  roles: UserRoleRef[];
  can_manage: boolean;
};

/** Карточка пользователя (access_user). */
export type PortalUserCard = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  user_type: UserType | null;
  position_id: string | null;
  status: UserStatus;
  access_until: string | null;
  note: string | null;
  blocked_at: string | null;
  blocked_reason: string | null;
  created_at: string;
  created_by_name: string | null;
  last_sign_in_at: string | null;
  can_manage: boolean;
  effective: Effective;
  units: { unit_id: string; member_role: MemberRole }[];
  /** Личные назначения ролей (без личных прав). */
  assignments: Assignment[];
  personal_role_id: string | null;
  personal: RolePerm[];
};

/** Откуда право (access_explain). */
export type ExplainRow = {
  assignment_id: string;
  role_id: string;
  role_name: string;
  personal: boolean;
  subject_type: SubjectType;
  via: string;
  scope_type: ScopeType;
  scope_ids: string[];
  valid_from: string | null;
  valid_until: string | null;
  perm_key: string | null;
  target_id: string | null;
  level: string | null;
};

export type OrgUnit = {
  id: string;
  parent_id: string | null;
  name: string;
  description: string | null;
  sort_order: number;
  path: string[];
};

export type OrgMember = { unit_id: string; user_id: string; member_role: MemberRole };
export type OrgPosition = {
  id: string;
  name: string;
  description: string | null;
  sort_order: number;
};
export type OrgBrand = {
  id: string;
  name: string;
  short_name: string | null;
  color: string | null;
  sort_order: number;
};
export type NetworkStudio = {
  id: string;
  name: string;
  format: string;
  brand_id: string | null;
  ownership: "own" | "franchise";
  city: string | null;
};

export type AccessLogRow = {
  id: number;
  at: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  target_user: string | null;
  target_name: string | null;
  target_role: string | null;
  summary: string | null;
  details: Record<string, unknown>;
};

/** Свои права (access_me). */
export type AccessMe = {
  /** В новой модели (иначе — прежние правила владельца). */
  managed: boolean;
  portal: boolean;
  rights: string[];
  manage_all: boolean;
  manage_studio_ids: string[];
};
