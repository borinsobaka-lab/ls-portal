-- Голосовые сообщения в чатах (решение владельца 2026-11-08, «как в
-- Telegram»): пока поле ввода пустое, вместо «Отправить» — микрофон,
-- запись — пока кнопка нажата. Голосовое — обычное вложение `chat-files`
-- (звук записывает браузер: webm/opus, у Safari — mp4/aac) с пометкой
-- `voice: true`, длительностью `duration` (секунды, до 2 часов) и волной
-- `waveform` (до 100 чисел 0–100 — полоски плеера; считает браузер при
-- записи, без неё плеер рисует ровную полосу).
--
-- `chat_check_attachments` раньше отбрасывал всё, кроме пути, имени, типа,
-- размера и размеров картинки, — теперь пропускает и эти три поля (только у
-- звука: `mime` audio/*; неверная волна или длительность — без них, файл
-- принимается). Превью для списка чатов, пуша и письма —
-- «Голосовое сообщение (0:12)» (`chat_preview_text`). Прежние сообщения не
-- меняются: превью хранится в `chat_chats.last_message` на момент отправки.

create or replace function public.chat_voice_waveform(p jsonb)
returns jsonb
language sql
immutable
as $$
  select case
    when jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) between 1 and 100
     and not exists (
       select 1 from jsonb_array_elements(p) x
        where jsonb_typeof(x) <> 'number' or (x::text)::numeric not between 0 and 100
     )
    then (select jsonb_agg(round((x::text)::numeric)::int) from jsonb_array_elements(p) x)
  end
$$;

create or replace function public.chat_check_attachments(p_chat uuid, p_attachments jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  a jsonb;
  v_voice boolean;
  out jsonb := '[]'::jsonb;
begin
  if p_attachments is null or jsonb_typeof(p_attachments) <> 'array' then
    return '[]'::jsonb;
  end if;
  if jsonb_array_length(p_attachments) > 20 then
    raise exception 'chat_too_many_files' using errcode = '22023';
  end if;
  for a in select * from jsonb_array_elements(p_attachments) loop
    if jsonb_typeof(a) <> 'object' or coalesce(a->>'path', '') not like p_chat::text || '/%'
       or char_length(a->>'path') > 500 or coalesce(a->>'name', '') = '' then
      raise exception 'chat_file_invalid' using errcode = '22023';
    end if;
    v_voice := coalesce(a->'voice' = 'true'::jsonb, false)
               and coalesce(a->>'mime', '') like 'audio/%';
    out := out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'path', a->>'path',
      'name', left(a->>'name', 200),
      'mime', left(coalesce(a->>'mime', 'application/octet-stream'), 100),
      'size', case when jsonb_typeof(a->'size') = 'number' then (a->>'size')::bigint end,
      'width', case when jsonb_typeof(a->'width') = 'number' then (a->>'width')::int end,
      'height', case when jsonb_typeof(a->'height') = 'number' then (a->>'height')::int end,
      'voice', case when v_voice then true end,
      'duration', case
        when v_voice and jsonb_typeof(a->'duration') = 'number'
         and (a->>'duration')::numeric between 0 and 7200
        then round((a->>'duration')::numeric, 1)
      end,
      'waveform', case when v_voice then public.chat_voice_waveform(a->'waveform') end)));
  end loop;
  return out;
end;
$$;

-- Превью для списка чатов, пуша и письма.
create or replace function public.chat_preview_text(p_text text, p_attachments jsonb)
returns text
language sql
immutable
as $$
  select case
    when btrim(coalesce(p_text, '')) <> '' then left(regexp_replace(btrim(p_text), '\s+', ' ', 'g'), 200)
    when jsonb_array_length(coalesce(p_attachments, '[]')) = 0 then ''
    when (p_attachments->0->'voice') = 'true'::jsonb then
      'Голосовое сообщение' || coalesce(
        ' (' || (floor((p_attachments->0->>'duration')::numeric / 60))::int || ':'
             || lpad((floor((p_attachments->0->>'duration')::numeric) % 60)::int::text, 2, '0') || ')',
        '')
    when (p_attachments->0->>'mime') like 'image/%' then 'Фото'
    when (p_attachments->0->>'mime') like 'video/%' then 'Видео'
    else 'Файл: ' || coalesce(p_attachments->0->>'name', '')
  end
$$;

revoke all on function public.chat_voice_waveform(jsonb) from public, anon, authenticated;
