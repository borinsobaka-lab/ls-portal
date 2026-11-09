-- Счётчик «Чатов» и значок приложения: чат «только упоминания» — тихий
-- (UI_REVIEW_CHATS_TASKS_CALENDAR.md, 3.1.1, решение 2026-11-09).
--
-- Портал считает чат заглушённым, если уведомления не «все» или «без звука»
-- до срока (`isMuted` в apps/admin/src/lib/chats/content.ts): у такого чата
-- счётчик серый и не входит в число на папке. База же считала громким и
-- «только упоминания» — цифра на «Чатах» в рейке и на значке приложения не
-- совпадала со списком. Упоминание и ответ по-прежнему не теряются: они
-- приходят в «Уведомления» (`chat.mention`, строка ленты) и считаются там.
--
-- Прежние определения — 2026-11-08_zzzzzzzzzzzzz_chat_topics.sql; актуальные
-- `chat_has_new`, `chat_unread_summary`, `portal_badge_count` — здесь.

create or replace function public.chat_has_new(p_chat uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.chat_chats t
      join public.chat_members tm on tm.chat_id = t.id and tm.user_id = p_user
     where t.parent_id = p_chat and t.last_seq > tm.last_read_seq and tm.notify = 'all'
       and (tm.muted_until is null or tm.muted_until < now()))
$$;

create or replace function public.chat_unread_summary()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select (c.last_seq > cm.last_read_seq
            or (c.kind = 'group' and public.chat_has_new(c.id, cm.user_id))) as has_new,
           cm.notify = 'all' and (cm.muted_until is null or cm.muted_until < now()) as loud
      from public.chat_members cm join public.chat_chats c on c.id = cm.chat_id
     where cm.user_id = auth.uid() and c.kind <> 'topic'
  )
  select jsonb_build_object(
    'chats', count(*) filter (where has_new and loud),
    'muted', count(*) filter (where has_new and not loud))
    from mine
$$;

create or replace function public.portal_badge_count(p_user uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select (select count(*)::int from public.notif_items
           where user_id = p_user and read_at is null and feed)
       + (select count(*)::int
            from public.chat_members cm join public.chat_chats c on c.id = cm.chat_id
           where cm.user_id = p_user and c.kind <> 'topic' and cm.notify = 'all'
             and (cm.muted_until is null or cm.muted_until < now())
             and (c.last_seq > cm.last_read_seq
                  or (c.kind = 'group' and public.chat_has_new(c.id, p_user))))
$$;
