-- ============================================================================
-- «Аналитика» → «Диалоги VK», часть 3 (ANALYTICS.md, «Диалоги VK»):
-- статистика лид-менеджеров — их vk_inbox.py (manager_statistics,
-- response_statistics, lead_statistics, manager_community_assignments) и
-- страница /admin/vk-inbox/statistics (app.py, inbox_statistics_page).
--
-- Кто видит (их правило): администратор аналитики и лид-менеджеры (право
-- an.inbox, и без назначенных сообществ). Лид-менеджеру — общая сводка
-- команды по всем активным сообществам, таблица групп — только его группы.
-- Контекст страницы (люди, сообщества, назначения) — an_inbox_stats_context
-- (от имени человека). Строки для расчёта — только серверу портала
-- (service_role): тексты сообщений с номерами телефонов из базы уходят
-- только на сервер, в браузер — итоги (их lead_statistics: «no tokens, phone
-- numbers or message bodies»). Идемпотентно.
-- ============================================================================

-- Их люди и сообщества страницы: лид-менеджеры (право an.inbox) с
-- назначениями и активностью; доступные человеку сообщества; все активные.
create or replace function public.an_inbox_stats_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_admin boolean := public.an_is_admin(v_uid);
begin
  if not v_admin and not public.an_inbox_is_manager(v_uid) then
    raise exception 'Нет доступа к диалогам VK. Попросите администратора назначить вам нужные сообщества.'
      using errcode = '42501';
  end if;
  return jsonb_build_object(
    'admin', v_admin,
    -- Их inbox_communities: доступные активные (фильтр «Группа VK»).
    'communities', (select coalesce(jsonb_agg(to_jsonb(a)), '[]')
                      from public.an_inbox_allowed(public.an_inbox_scope(v_uid)) a),
    -- Все активные: сводка команды для лид-менеджера.
    'active', (select coalesce(jsonb_agg(c.id order by c.id), '[]')
                 from public.an_inbox_communities c where c.is_active),
    'people', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'user_id', x.user_id,
               'full_name', coalesce(nullif(btrim(p.full_name), ''), u.email::text, ''),
               'active', public.is_portal_user(x.user_id),
               'communities', (select coalesce(jsonb_agg(uc.community_id order by uc.community_id), '[]')
                                 from public.an_inbox_user_communities uc where uc.user_id = x.user_id))
             order by coalesce(nullif(btrim(p.full_name), ''), u.email::text, '') collate "C", x.user_id), '[]')
        from (select distinct r.user_id from public.access_user_rights r
               where 'an.inbox' = any (r.rights)) x
        join auth.users u on u.id = x.user_id
        left join public.profiles p on p.id = x.user_id));
end;
$$;
revoke all on function public.an_inbox_stats_context() from public, anon;
grant execute on function public.an_inbox_stats_context() to authenticated;

-- Их manager_statistics (полуинтервал [p_start, p_end), авторство — по
-- сообщениям; первый ответ — от первого входящего до первого исходящего
-- после него, ответ напрямую из VK исключает замер).
create or replace function public.an_inbox_stat_managers(p_start timestamptz, p_end timestamptz, p_groups bigint[])
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with scoped_messages as not materialized (
    select * from public.an_inbox_messages where p_groups is null or community_id = any (p_groups)
  ), replies as (
    select portal_sender_user_id as user_id, count(*) as replies, count(distinct dialog_id) as dialogs
      from scoped_messages
     where direction = 'outgoing' and portal_sender_user_id is not null
       and sent_at >= p_start and sent_at < p_end
     group by portal_sender_user_id
  ), first_incoming as (
    select distinct on (m.dialog_id) m.dialog_id, m.sent_at, m.id
      from scoped_messages m
      join (select distinct dialog_id from scoped_messages
             where direction = 'outgoing' and portal_sender_user_id is not null
               and sent_at >= p_start and sent_at < p_end) candidates using (dialog_id)
     where m.direction = 'incoming'
     order by m.dialog_id, m.sent_at, m.id
  ), first_response as (
    select reply.portal_sender_user_id as user_id,
           extract(epoch from (reply.sent_at - incoming.sent_at)) as seconds
      from first_incoming incoming
      join lateral (
        select sent_at, portal_sender_user_id from scoped_messages m
         where m.dialog_id = incoming.dialog_id and m.direction = 'outgoing'
           and (m.sent_at, m.id) > (incoming.sent_at, incoming.id)
         order by m.sent_at, m.id limit 1) reply on true
     where reply.portal_sender_user_id is not null
       and reply.sent_at >= p_start and reply.sent_at < p_end
  ), durations as (
    select user_id, count(*) as first_responses,
           percentile_cont(0.5) within group (order by seconds) as median_seconds,
           percentile_cont(0.9) within group (order by seconds) as p90_seconds
      from first_response group by user_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', r.user_id, 'replies', r.replies, 'dialogs', r.dialogs,
           'first_responses', coalesce(d.first_responses, 0),
           'median_seconds', d.median_seconds, 'p90_seconds', d.p90_seconds)
         order by r.replies desc, r.user_id), '[]')
    from replies r left join durations d using (user_id)
$$;
revoke all on function public.an_inbox_stat_managers(timestamptz, timestamptz, bigint[]) from public, anon, authenticated;
grant execute on function public.an_inbox_stat_managers(timestamptz, timestamptz, bigint[]) to service_role;

-- Их response_statistics (запрос): все сообщения диалогов, где за период
-- отвечали из портала (выбранные менеджеры и группы), до конца периода, по
-- порядку. Строка: [диалог, группа, 'i'|'o', автор из портала, секунды].
create or replace function public.an_inbox_stat_reply_rows(
  p_start timestamptz, p_end timestamptz, p_managers uuid[], p_groups bigint[])
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with candidates as (
    select distinct dialog_id from public.an_inbox_messages
     where direction = 'outgoing' and portal_sender_user_id is not null
       and sent_at >= p_start and sent_at < p_end
       and (p_managers is null or portal_sender_user_id = any (p_managers))
       and (p_groups is null or community_id = any (p_groups))
  )
  select coalesce(jsonb_agg(jsonb_build_array(m.dialog_id, m.community_id,
           case when m.direction = 'incoming' then 'i' else 'o' end,
           m.portal_sender_user_id, extract(epoch from m.sent_at))
         order by m.dialog_id, m.sent_at, m.id), '[]')
    from public.an_inbox_messages m join candidates c on c.dialog_id = m.dialog_id
   where m.direction in ('incoming', 'outgoing') and m.sent_at < p_end
$$;
revoke all on function public.an_inbox_stat_reply_rows(timestamptz, timestamptz, uuid[], bigint[]) from public, anon, authenticated;
grant execute on function public.an_inbox_stat_reply_rows(timestamptz, timestamptz, uuid[], bigint[]) to service_role;

-- Их lead_statistics (три запроса): ответы менеджеров по дням МСК, лиды
-- (дата — первое сообщение истории VK, если сверено; первый контакт —
-- входящее или ответ не из портала), входящие с номерами (текст — только
-- серверу). Время — секунды Unix.
create or replace function public.an_inbox_stat_lead_rows(p_start timestamptz, p_end timestamptz, p_groups bigint[])
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'work', (
      select coalesce(jsonb_agg(jsonb_build_object('user_id', w.user_id, 'day', w.day,
               'replies', w.replies, 'dialog_ids', w.dialog_ids)), '[]')
        from (select portal_sender_user_id as user_id, (sent_at at time zone 'Europe/Moscow')::date as day,
                     count(*) as replies, array_agg(distinct dialog_id) as dialog_ids
                from public.an_inbox_messages
               where direction = 'outgoing' and portal_sender_user_id is not null
                 and sent_at >= p_start and sent_at < p_end
                 and (p_groups is null or community_id = any (p_groups))
               group by 1, 2) w),
    'leads', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'dialog_id', l.dialog_id, 'lead_at', extract(epoch from l.lead_at),
               'history_verified', l.history_verified,
               'incoming_at', extract(epoch from l.incoming_at),
               'community_id', l.community_id, 'community_name', l.community_name, 'city', l.city,
               'owner_id', l.owner_id, 'reply_at', extract(epoch from l.reply_at),
               'reply_user_id', l.reply_user_id)), '[]')
        from (
          with first_contact as (
            select dialog_id, min(sent_at) as lead_at from public.an_inbox_messages
             where direction = 'incoming' or (direction = 'outgoing' and portal_sender_user_id is null)
             group by dialog_id),
          first_incoming as (
            select distinct on (dialog_id) dialog_id, sent_at, id from public.an_inbox_messages
             where direction = 'incoming' and sent_at < p_end order by dialog_id, sent_at, id)
          select contact.dialog_id, least(history.first_message_at, contact.lead_at) as lead_at,
                 (history.checked_at is not null and history.first_message_at is not null) as history_verified,
                 incoming.sent_at as incoming_at, d.community_id,
                 c.display_name as community_name, c.city,
                 owner.portal_sender_user_id as owner_id,
                 reply.sent_at as reply_at, reply.portal_sender_user_id as reply_user_id
            from first_contact contact
            left join first_incoming incoming on incoming.dialog_id = contact.dialog_id
            join public.an_inbox_dialogs d on d.id = contact.dialog_id
            join public.an_inbox_communities c on c.id = d.community_id
            left join public.an_inbox_first_messages history on history.dialog_id = contact.dialog_id
            left join lateral (
              select m.portal_sender_user_id from public.an_inbox_messages m
               where m.dialog_id = contact.dialog_id and m.direction = 'outgoing'
                 and m.portal_sender_user_id is not null and m.sent_at < p_end
                 and m.sent_at >= contact.lead_at
               order by m.sent_at, m.id limit 1) owner on true
            left join lateral (
              select m.sent_at, m.portal_sender_user_id from public.an_inbox_messages m
               where m.dialog_id = incoming.dialog_id and m.direction = 'outgoing' and m.sent_at < p_end
                 and (m.sent_at, m.id) > (incoming.sent_at, incoming.id)
               order by m.sent_at, m.id limit 1) reply on true
           where least(history.first_message_at, contact.lead_at) < p_end
             and (p_groups is null or d.community_id = any (p_groups))) l),
    'phones', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', ph.id, 'dialog_id', ph.dialog_id, 'body', ph.body, 'sent_at', extract(epoch from ph.sent_at),
               'phone_owner_id', ph.phone_owner_id, 'bot_before_phone', ph.bot_before_phone)
             order by ph.sent_at, ph.id), '[]')
        from (
          select m.id, m.dialog_id, m.body, m.sent_at,
                 (select p.portal_sender_user_id from public.an_inbox_messages p
                   where p.dialog_id = m.dialog_id and p.direction = 'outgoing' and p.portal_sender_user_id is not null
                     and (p.sent_at, p.id) < (m.sent_at, m.id)
                   order by p.sent_at desc, p.id desc limit 1) as phone_owner_id,
                 exists (select 1 from public.an_inbox_messages b
                          where b.dialog_id = m.dialog_id and b.direction = 'outgoing'
                            and b.portal_sender_user_id is null
                            and (b.sent_at, b.id) < (m.sent_at, m.id)) as bot_before_phone
            from public.an_inbox_messages m
           where m.direction = 'incoming' and m.sent_at < p_end
             and m.body ~ '([0-9][[:space:]().-]*){10}'
             and (p_groups is null or m.community_id = any (p_groups))) ph))
$$;
revoke all on function public.an_inbox_stat_lead_rows(timestamptz, timestamptz, bigint[]) from public, anon, authenticated;
grant execute on function public.an_inbox_stat_lead_rows(timestamptz, timestamptz, bigint[]) to service_role;
