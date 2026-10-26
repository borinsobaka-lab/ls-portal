-- ============================================================================
-- Kate: один диалог на сотрудника (решение владельца 2026-10-20).
--
-- Новых чатов в окне Kate нет: у сотрудника одна переписка, вся хронология —
-- в ней (assistant_threads из 2026-10-19_zz_assistant_kate.sql — теперь
-- строка на сотрудника). Если диалогов уже несколько, сообщения переносятся
-- в самый ранний, остальные удаляются; второй диалог не даст завести
-- уникальный индекс. Идемпотентно.
-- ============================================================================

-- Сообщения — в самый ранний диалог сотрудника. Совпавший id сообщения
-- (не бывает: id случайные) не переносится, чтобы не упасть на ключе.
with keep as (
  select distinct on (user_id) user_id, id
    from public.assistant_threads
   order by user_id, created_at, id
)
update public.assistant_messages m
   set thread_id = k.id
  from public.assistant_threads t
  join keep k on k.user_id = t.user_id
 where m.thread_id = t.id
   and t.id <> k.id
   and not exists (select 1 from public.assistant_messages x
                    where x.thread_id = k.id and x.id = m.id);

delete from public.assistant_threads t
 where exists (select 1 from public.assistant_threads e
                where e.user_id = t.user_id
                  and (e.created_at, e.id) < (t.created_at, t.id));

create unique index if not exists assistant_threads_one_per_user
  on public.assistant_threads (user_id);

comment on table public.assistant_threads is
  'Переписка сотрудника с AI-ассистентом Kate: одна на сотрудника (assistant_threads_one_per_user). Видит и правит только автор.';

notify pgrst, 'reload schema';
