-- ============================================================================
-- «Аналитика» → «Диалоги VK», часть 2 (ANALYTICS.md, «Диалоги VK»): очередь
-- диалогов, переписка, «Непрочитанные», шаблоны ответов, запись ответа из
-- портала — их vk_inbox.py (list_dialogs, dialog_counts, updates_marker,
-- ensure_user_read_baseline, mark_dialog_read, dialog_messages,
-- message_photos, message_stickers, list/save/delete_reply_template,
-- send_operator_message) и страницы /admin/vk-inbox, /admin/vk-inbox/dialogs,
-- /admin/vk-inbox/updates, /admin/vk-inbox/templates (app.py).
--
-- Доступ — их inbox_scope (an_inbox_scope, часть 1): администратор
-- аналитики — все сообщества, лид-менеджер — назначенные; без сообществ —
-- «Нет доступа к диалогам VK». Фильтр группы сужает доступное (их
-- inbox_filter_scope). Прочтение — у каждого своё (их dialog_reads), при
-- первом входе всё прежнее считается прочитанным (их базовая линия).
-- Браузеру — только RPC: картинки и стикеры база достаёт из сообщения VK
-- (только https-адреса), само сообщение VK в браузер не уходит.
--
-- Отправку в VK делает сервер портала (токен группы, загрузка фото,
-- messages.send) — сюда приходит только итог (an_inbox_reply_store,
-- service_role). Идемпотентно.
-- ============================================================================

-- 1) Внутренние ------------------------------------------------------------------

-- Доступ вызывающего: их has_inbox_access. Возвращает scope (null — все).
create or replace function public.an_inbox_require()
returns bigint[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_scope bigint[] := public.an_inbox_scope(auth.uid());
begin
  if v_scope is not null and cardinality(v_scope) = 0 then
    raise exception 'Нет доступа к диалогам VK. Попросите администратора назначить вам нужные сообщества.'
      using errcode = '42501';
  end if;
  return v_scope;
end;
$$;
revoke all on function public.an_inbox_require() from public, anon, authenticated;

-- Их inbox_communities: подключённые активные сообщества в доступе (порядок
-- их list_communities).
create or replace function public.an_inbox_allowed(p_scope bigint[])
returns table (id bigint, display_name text, brand text, city text)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.display_name, c.brand, c.city
    from public.an_inbox_communities c
   where c.is_active and (p_scope is null or c.id = any (p_scope))
   order by c.brand, c.city collate "C", c.display_name collate "C"
$$;
revoke all on function public.an_inbox_allowed(bigint[]) from public, anon, authenticated;

-- Их inbox_filter_scope: выбранная группа, если она в доступе, иначе весь доступ.
create or replace function public.an_inbox_visible(p_scope bigint[], p_community bigint)
returns bigint[]
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_community is not null and p_community > 0
         and exists (select 1 from public.an_inbox_allowed(p_scope) a where a.id = p_community)
      then array[p_community]
    else p_scope end
$$;
revoke all on function public.an_inbox_visible(bigint[], bigint) from public, anon, authenticated;

-- Их strip()[:100] дважды (страница, затем list_dialogs).
create or replace function public.an_inbox_search_text(p text)
returns text
language sql
immutable
as $$
  select left(regexp_replace(left(regexp_replace(coalesce(p, ''), '^\s+|\s+$', '', 'g'), 100),
                             '^\s+|\s+$', '', 'g'), 100)
$$;

-- Ширина размера картинки VK как у них: нет поля — 0, число (и bool), иначе — не годится.
create or replace function public.an_inbox_width(p jsonb, p_has boolean)
returns numeric
language sql
immutable
as $$
  select case when not p_has then 0
              when jsonb_typeof(p) = 'number' then p::text::numeric
              when jsonb_typeof(p) = 'boolean' then case when p::text = 'true' then 1 else 0 end
         end
$$;

-- Их выбор самой широкой https-картинки из списка (первая из равных).
create or replace function public.an_inbox_widest(p jsonb)
returns text
language sql
immutable
as $$
  select s.v->>'url'
    from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end)
         with ordinality s(v, o)
   where jsonb_typeof(s.v) = 'object'
     and jsonb_typeof(s.v->'url') = 'string'
     and s.v->>'url' like 'https://%'
     and public.an_inbox_width(s.v->'width', s.v ? 'width') is not null
   order by public.an_inbox_width(s.v->'width', s.v ? 'width') desc, s.o
   limit 1
$$;

-- Их message_photos / message_stickers / has_sticker по сообщению VK.
create or replace function public.an_inbox_media(p jsonb)
returns jsonb
language sql
immutable
as $$
  with att as (
    select a.v, a.o
      from jsonb_array_elements(case when jsonb_typeof(p->'attachments') = 'array'
                                     then p->'attachments' else '[]'::jsonb end) with ordinality a(v, o)
  )
  select jsonb_build_object(
    'photos', coalesce((
      select jsonb_agg(x.u order by x.o) from (
        select att.o, public.an_inbox_widest(att.v->'photo'->'sizes') as u
          from att
         where att.o <= 10 and jsonb_typeof(att.v) = 'object' and att.v->'type' = '"photo"'::jsonb
           and jsonb_typeof(att.v->'photo') = 'object'
           and jsonb_typeof(att.v->'photo'->'sizes') = 'array') x
       where x.u is not null), '[]'::jsonb),
    'stickers', coalesce((
      select jsonb_agg(x.u order by x.o) from (
        select att.o, coalesce(
                 case when jsonb_typeof(att.v->'sticker'->'images') = 'array'
                      then public.an_inbox_widest(att.v->'sticker'->'images') end,
                 case when jsonb_typeof(att.v->'sticker'->'images_with_background') = 'array'
                      then public.an_inbox_widest(att.v->'sticker'->'images_with_background') end) as u
          from att
         where att.o <= 10 and jsonb_typeof(att.v) = 'object' and att.v->'type' = '"sticker"'::jsonb
           and jsonb_typeof(att.v->'sticker') = 'object') x
       where x.u is not null), '[]'::jsonb),
    'has_sticker', exists (select 1 from att
                            where jsonb_typeof(att.v) = 'object' and att.v->'type' = '"sticker"'::jsonb))
$$;

-- 2) Очередь и переписка (лид-менеджер и администратор аналитики) -----------------

-- Их страница /admin/vk-inbox и /admin/vk-inbox/dialogs: базовая линия
-- прочтения (первый вход), страница очереди, счётчики «Все / Непрочитанные»,
-- метка обновлений и группы фильтра. Первая страница у них — 200, дальше по 100.
create or replace function public.an_inbox_queue(
  p_community bigint, p_unread boolean, p_search text, p_offset integer, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_scope bigint[] := public.an_inbox_require();
  v_vis bigint[] := public.an_inbox_visible(v_scope, p_community);
  v_search text := public.an_inbox_search_text(p_search);
  v_pattern text;
  v_limit integer := greatest(1, least(coalesce(p_limit, 200), 500));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_new uuid;
  v_dialogs jsonb;
  v_counts jsonb;
  v_marker text;
begin
  -- Их ensure_user_read_baseline (по всему доступу, не по фильтру).
  insert into public.an_inbox_user_read_baselines (user_id) values (v_uid)
  on conflict do nothing returning user_id into v_new;
  if v_new is not null then
    insert into public.an_inbox_dialog_reads (user_id, dialog_id, last_read_message_id)
    select v_uid, d.id, coalesce((select max(m.id) from public.an_inbox_messages m where m.dialog_id = d.id), 0)
      from public.an_inbox_dialogs d
      join public.an_inbox_communities c on c.id = d.community_id and c.is_active
     where v_scope is null or d.community_id = any (v_scope)
    on conflict (user_id, dialog_id) do nothing;
  end if;

  if v_search <> '' then
    v_pattern := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.last_message_at desc nulls last, q.id desc), '[]')
    into v_dialogs
    from (
      select d.id, d.community_id, d.peer_id, d.customer_vk_id, d.customer_name, d.customer_avatar_url,
             d.status, d.last_message_at, c.display_name as community_name, c.brand, c.city,
             case when coalesce(lm.body, '') = '' then
                    case when lm.is_sticker then 'Стикер' when lm.is_photo then 'Картинка' else lm.body end
                  else lm.body end as last_body,
             lm.direction as last_direction,
             exists (select 1 from public.an_inbox_messages um
                      where um.dialog_id = d.id and um.direction = 'incoming'
                        and um.id > coalesce(r.last_read_message_id, 0)) as has_unread,
             lm.sent_at as last_sent_at
        from public.an_inbox_dialogs d
        join public.an_inbox_communities c on c.id = d.community_id and c.is_active
        left join public.an_inbox_dialog_reads r on r.dialog_id = d.id and r.user_id = v_uid
        left join lateral (
          select m.body, m.direction, m.sent_at,
                 (m.raw_payload->'attachments') @> '[{"type":"sticker"}]'::jsonb as is_sticker,
                 (m.raw_payload->'attachments') @> '[{"type":"photo"}]'::jsonb as is_photo
            from public.an_inbox_messages m
           where m.dialog_id = d.id order by m.sent_at desc, m.id desc limit 1) lm on true
       where (v_vis is null or d.community_id = any (v_vis))
         and (v_pattern is null
              or d.customer_name ilike v_pattern or d.peer_id::text ilike v_pattern
              or exists (select 1 from public.an_inbox_messages sm
                          where sm.dialog_id = d.id and sm.body ilike v_pattern))
         and (not coalesce(p_unread, false)
              or exists (select 1 from public.an_inbox_messages um
                          where um.dialog_id = d.id and um.direction = 'incoming'
                            and um.id > coalesce(r.last_read_message_id, 0)))
       order by d.last_message_at desc nulls last, d.id desc
       limit v_limit offset v_offset) q;

  -- Их dialog_counts: по группе фильтра, без поиска и страницы.
  select jsonb_build_object('total', count(*),
           'unread', count(*) filter (where exists (
              select 1 from public.an_inbox_messages m where m.dialog_id = d.id
                 and m.direction = 'incoming' and m.id > coalesce(r.last_read_message_id, 0))))
    into v_counts
    from public.an_inbox_dialogs d
    join public.an_inbox_communities c on c.id = d.community_id and c.is_active
    left join public.an_inbox_dialog_reads r on r.dialog_id = d.id and r.user_id = v_uid
   where v_vis is null or d.community_id = any (v_vis);

  v_marker := public.an_inbox_marker_for(v_vis);
  return jsonb_build_object(
    'admin', public.an_is_admin(v_uid),
    -- Их selected_community_id: выбранная группа, если она в доступе.
    'community', (select a.id from public.an_inbox_allowed(v_scope) a where a.id = p_community),
    'communities', (select coalesce(jsonb_agg(to_jsonb(a)), '[]') from public.an_inbox_allowed(v_scope) a),
    'dialogs', v_dialogs,
    'counts', v_counts,
    'marker', v_marker,
    'next_offset', case when jsonb_array_length(v_dialogs) = v_limit
                        then v_offset + v_limit end);
end;
$$;

-- Их updates_marker: число и последнее сообщение, последнее изменение диалога.
create or replace function public.an_inbox_marker_for(p_vis bigint[])
returns text
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::text || ':' || coalesce(max(m.id), 0)::text || ':' ||
         coalesce((select max(d.updated_at)::text from public.an_inbox_dialogs d
                    where p_vis is null or d.community_id = any (p_vis)), '')
    from public.an_inbox_messages m
   where p_vis is null or m.community_id = any (p_vis)
$$;
revoke all on function public.an_inbox_marker_for(bigint[]) from public, anon, authenticated;

revoke all on function public.an_inbox_queue(bigint, boolean, text, integer, integer) from public, anon;
grant execute on function public.an_inbox_queue(bigint, boolean, text, integer, integer) to authenticated;

-- Их /admin/vk-inbox/updates: метка без загрузки очереди (опрос раз в 8 с).
create or replace function public.an_inbox_marker(p_community bigint)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return public.an_inbox_marker_for(public.an_inbox_visible(public.an_inbox_require(), p_community));
end;
$$;
revoke all on function public.an_inbox_marker(bigint) from public, anon;
grant execute on function public.an_inbox_marker(bigint) to authenticated;

-- Их mark_dialog_read + dialog_messages: открыть диалог (по желанию —
-- прочитать), 200 сообщений до p_before по порядку, есть ли раньше.
create or replace function public.an_inbox_open(
  p_dialog bigint, p_community bigint, p_mark boolean, p_before bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_vis bigint[] := public.an_inbox_visible(public.an_inbox_require(), p_community);
  v_dialog jsonb;
  v_rows jsonb;
  v_count integer;
begin
  if coalesce(p_mark, false) then
    insert into public.an_inbox_dialog_reads (user_id, dialog_id, last_read_message_id, updated_at)
    select v_uid, d.id, coalesce((select max(m.id) from public.an_inbox_messages m where m.dialog_id = d.id), 0), now()
      from public.an_inbox_dialogs d
      join public.an_inbox_communities c on c.id = d.community_id and c.is_active
     where d.id = p_dialog and (v_vis is null or d.community_id = any (v_vis))
    on conflict (user_id, dialog_id) do update
      set last_read_message_id = excluded.last_read_message_id, updated_at = now();
  end if;
  select to_jsonb(x) into v_dialog
    from (select d.id, d.community_id, d.peer_id, d.customer_vk_id, d.customer_name,
                 d.customer_avatar_url, d.status, d.last_message_at,
                 c.display_name as community_name, c.brand, c.city
            from public.an_inbox_dialogs d
            join public.an_inbox_communities c on c.id = d.community_id and c.is_active
           where d.id = p_dialog and (v_vis is null or d.community_id = any (v_vis))) x;
  if v_dialog is null then
    raise exception 'Диалог не найден или сообщество отключено.' using errcode = 'P0002';
  end if;
  select count(*), coalesce(jsonb_agg(to_jsonb(y) - 'n' order by y.sent_at, y.id) filter (where y.n <= 200), '[]')
    into v_count, v_rows
    from (select m.id, m.direction, m.body, m.vk_sender_id, m.portal_sender_user_id, m.sent_at,
                 m.edited_at, public.an_inbox_media(m.raw_payload) as media,
                 row_number() over (order by m.sent_at desc, m.id desc) as n
            from public.an_inbox_messages m
           where m.dialog_id = p_dialog and (p_before is null or m.id < p_before)
           order by m.sent_at desc, m.id desc
           limit 201) y;
  return jsonb_build_object('dialog', v_dialog, 'messages', v_rows, 'has_more', v_count > 200);
end;
$$;
revoke all on function public.an_inbox_open(bigint, bigint, boolean, bigint) from public, anon;
grant execute on function public.an_inbox_open(bigint, bigint, boolean, bigint) to authenticated;

-- 3) Шаблоны ответов (их list/save/delete_reply_template) ------------------------

create or replace function public.an_inbox_templates()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  perform public.an_inbox_require();
  return jsonb_build_object(
    'admin', public.an_is_admin(v_uid),
    'templates', (
      select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'body', t.body,
                                                   'visibility', t.visibility)
                                order by t.visibility, lower(t.title), t.id), '[]')
        from public.an_inbox_reply_templates t
       where t.created_by = v_uid or t.visibility = 'shared'));
end;
$$;
revoke all on function public.an_inbox_templates() from public, anon;
grant execute on function public.an_inbox_templates() to authenticated;

-- Их save_reply_template: общие — только администратору аналитики.
create or replace function public.an_inbox_template_save(
  p_id bigint, p_title text, p_body text, p_visibility text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_title text := regexp_replace(coalesce(p_title, ''), '^\s+|\s+$', '', 'g');
  v_body text := regexp_replace(coalesce(p_body, ''), '^\s+|\s+$', '', 'g');
  v_vis text := coalesce(nullif(p_visibility, ''), 'personal');
begin
  perform public.an_inbox_require();
  if v_vis not in ('personal', 'shared') then
    raise exception 'Неизвестный тип шаблона.' using errcode = '22023';
  end if;
  if v_vis = 'shared' and not public.an_is_admin(v_uid) then
    raise exception 'Общие шаблоны редактирует администратор.' using errcode = '42501';
  end if;
  if char_length(v_title) not between 1 and 100 or char_length(v_body) not between 1 and 4096 then
    raise exception 'Название: 1–100 символов. Текст шаблона: 1–4096 символов.' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.an_inbox_reply_templates (title, body, created_by, updated_by, visibility)
    values (v_title, v_body, v_uid, v_uid, v_vis);
  elsif v_vis = 'shared' then
    update public.an_inbox_reply_templates
       set title = v_title, body = v_body, updated_by = v_uid, updated_at = now()
     where id = p_id and visibility = 'shared';
    if not found then
      raise exception 'Общий шаблон не найден.' using errcode = 'P0002';
    end if;
  else
    update public.an_inbox_reply_templates
       set title = v_title, body = v_body, updated_by = v_uid, updated_at = now()
     where id = p_id and created_by = v_uid and visibility = 'personal';
    if not found then
      raise exception 'Шаблон не найден. Обновите страницу.' using errcode = 'P0002';
    end if;
  end if;
end;
$$;
revoke all on function public.an_inbox_template_save(bigint, text, text, text) from public, anon;
grant execute on function public.an_inbox_template_save(bigint, text, text, text) to authenticated;

create or replace function public.an_inbox_template_delete(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  perform public.an_inbox_require();
  delete from public.an_inbox_reply_templates
   where id = p_id
     and ((created_by = v_uid and visibility = 'personal')
          or (visibility = 'shared' and public.an_is_admin(v_uid)));
  if not found then
    raise exception 'Шаблон уже удалён или не найден.' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function public.an_inbox_template_delete(bigint) from public, anon;
grant execute on function public.an_inbox_template_delete(bigint) to authenticated;

-- 4) Ответ из портала (их send_operator_message) -----------------------------------

-- Куда отправлять: диалог в доступе вызывающего (их scope, без фильтра группы)
-- и активное сообщество. Токен сервер берёт из an_secrets.
create or replace function public.an_inbox_reply_target(p_dialog bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_scope bigint[] := public.an_inbox_require();
  v jsonb;
begin
  select jsonb_build_object('id', d.id, 'community_id', d.community_id, 'peer_id', d.peer_id,
                            'vk_community_id', c.vk_community_id)
    into v
    from public.an_inbox_dialogs d
    join public.an_inbox_communities c on c.id = d.community_id
   where d.id = p_dialog and c.is_active and (v_scope is null or d.community_id = any (v_scope));
  if v is null then
    raise exception 'Диалог не найден или сообщество отключено.' using errcode = 'P0002';
  end if;
  return v;
end;
$$;
revoke all on function public.an_inbox_reply_target(bigint) from public, anon;
grant execute on function public.an_inbox_reply_target(bigint) to authenticated;

-- Итог отправки (сервер портала): сообщение в переписку (их _store_message
-- с типом portal_message), автор — человек портала, диалог — «ждём клиента»,
-- первый ответ и ответственный (если не было), событие operator_reply, журнал.
create or replace function public.an_inbox_reply_store(
  p_user uuid, p_dialog bigint, p_vk_message_id bigint, p_text text, p_photos jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_d record;
  v_now bigint := floor(extract(epoch from now()))::bigint;
  v_photos jsonb := case when jsonb_typeof(p_photos) = 'array' then p_photos else '[]'::jsonb end;
begin
  select d.id, d.community_id, d.peer_id, c.vk_community_id into v_d
    from public.an_inbox_dialogs d join public.an_inbox_communities c on c.id = d.community_id
   where d.id = p_dialog;
  if not found then
    raise exception 'Диалог не найден или сообщество отключено.' using errcode = 'P0002';
  end if;
  perform public.an_inbox_store_message(v_d.community_id, 'portal_message', v_d.peer_id, p_vk_message_id,
    v_now, -v_d.vk_community_id, true, null, coalesce(p_text, ''),
    jsonb_build_object('peer_id', v_d.peer_id, 'id', p_vk_message_id, 'date', v_now,
                       'from_id', -v_d.vk_community_id, 'out', 1, 'text', coalesce(p_text, ''),
                       'attachments', (select coalesce(jsonb_agg(jsonb_build_object('type', 'photo', 'photo', x.v)
                                                                 order by x.o), '[]'::jsonb)
                                         from jsonb_array_elements(v_photos) with ordinality x(v, o))));
  update public.an_inbox_messages set portal_sender_user_id = p_user
   where community_id = v_d.community_id and vk_message_id = p_vk_message_id;
  update public.an_inbox_dialogs
     set assigned_user_id = coalesce(assigned_user_id, p_user),
         first_operator_reply_at = coalesce(first_operator_reply_at, now()),
         status = 'waiting_customer', updated_at = now()
   where id = p_dialog;
  insert into public.an_inbox_events (dialog_id, actor_user_id, event_type, payload_json)
  values (p_dialog, p_user, 'operator_reply', jsonb_build_object('vk_message_id', p_vk_message_id));
  perform public.an_audit_add(p_user, 'vk_inbox_reply_sent', p_dialog::text);
end;
$$;
revoke all on function public.an_inbox_reply_store(uuid, bigint, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.an_inbox_reply_store(uuid, bigint, bigint, text, jsonb) to service_role;
