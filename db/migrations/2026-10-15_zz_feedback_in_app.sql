-- Обратная связь — своя форма в клиентском приложении (решение владельца
-- 2026-10-15): кнопка «Фидбэк» на главной больше не ведёт на внешний сервис
-- (studio_app_settings.feedback_url не используется), а открывает форму
-- /feedback приложения. Та же форма открывается и без входа — по ссылке или
-- QR-коду клуба (`/feedback?studio=<id>`, раздел «Обратная связь» админки),
-- поэтому отправлять обращение может и anon. Читают, отрабатывают и удаляют
-- по-прежнему только сотрудники (политики db/security_hardening.sql).
--
-- Таблица feedback — db/feedback.sql + db/feedback_nps_studio.sql (studio_id).

-- Откуда пришло обращение: app — из приложения (клиент вошёл), link — по
-- ссылке или QR-коду без входа, portal — добавил сотрудник в админке.
-- Старые строки — null.
alter table public.feedback add column if not exists source text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'feedback_source_check' and conrelid = 'public.feedback'::regclass
  ) then
    alter table public.feedback
      add constraint feedback_source_check
      check (source is null or source in ('app', 'link', 'portal'));
  end if;
  -- Публичная вставка — без входа: ограничиваем размер полей.
  if not exists (
    select 1 from pg_constraint
    where conname = 'feedback_lengths_check' and conrelid = 'public.feedback'::regclass
  ) then
    alter table public.feedback
      add constraint feedback_lengths_check
      check (
        char_length(btrim(message)) between 1 and 4000
        and coalesce(char_length(client_name), 0) <= 200
        and coalesce(char_length(client_contact), 0) <= 200
        and coalesce(char_length(resolution_comment), 0) <= 4000
      ) not valid;
  end if;
end $$;

-- Не сотрудник не может прислать «уже отработанное» обращение или задним
-- числом: статус, поля отработки и дата ставятся здесь. BEFORE-триггер
-- срабатывает до проверки RLS, политика видит уже исправленную строку.
create or replace function public.feedback_insert_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_staff(auth.uid()) then
    new.status := 'pending';
    new.resolved_by := null;
    new.resolved_by_name := null;
    new.resolved_at := null;
    new.resolution_comment := null;
    new.created_at := now();
    new.source := case when auth.uid() is null then 'link' else 'app' end;
  end if;
  return new;
end;
$$;

drop trigger if exists feedback_insert_guard_bi on public.feedback;
create trigger feedback_insert_guard_bi
  before insert on public.feedback
  for each row execute function public.feedback_insert_guard();

-- Вставка: клиент приложения и посетитель по ссылке — только в клуб
-- (студия обязательна, без неё обращение никому не видно); сотрудник — как
-- раньше, из админки.
drop policy if exists "feedback auth insert" on public.feedback;
drop policy if exists "feedback public insert" on public.feedback;
drop policy if exists "feedback staff insert" on public.feedback;
create policy "feedback public insert" on public.feedback
  for insert to anon, authenticated
  with check (studio_id is not null and status = 'pending' and source in ('app', 'link'));
create policy "feedback staff insert" on public.feedback
  for insert to authenticated
  with check (public.is_staff(auth.uid()));

grant insert on public.feedback to anon;

notify pgrst, 'reload schema';
