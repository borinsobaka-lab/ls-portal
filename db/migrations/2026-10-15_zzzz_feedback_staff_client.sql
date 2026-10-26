-- Обратная связь: обращение сотрудника-клиента из приложения (исправление по
-- код-ревью 2026-10-15, 2026-10-15_zz_feedback_in_app.sql).
--
-- feedback_insert_guard пропускал любую вставку сотрудника как есть, поэтому
-- тренер, который ещё и клиент клуба, присылал из формы приложения
-- обращение без источника (source null — в админке не видно, что оно из
-- приложения) и мог задать статус и дату. Теперь как есть сохраняется
-- только запись из админки (source = 'portal', «Добавить обращение»);
-- остальное — обращение из приложения или по ссылке, как у клиента.
-- Актуальное определение feedback_insert_guard — здесь.
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).

create or replace function public.feedback_insert_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and new.source = 'portal' and public.is_staff(auth.uid()) then
    return new;
  end if;
  new.status := 'pending';
  new.resolved_by := null;
  new.resolved_by_name := null;
  new.resolved_at := null;
  new.resolution_comment := null;
  new.created_at := now();
  new.source := case when auth.uid() is null then 'link' else 'app' end;
  return new;
end;
$$;

drop trigger if exists feedback_insert_guard_bi on public.feedback;
create trigger feedback_insert_guard_bi
  before insert on public.feedback
  for each row execute function public.feedback_insert_guard();
