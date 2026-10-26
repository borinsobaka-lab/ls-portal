-- Переезд на self-hosted Supabase (2026-10-07): старый облачный хост в данных.
--
-- Клиентское приложение сохраняет в clients.photo_url ПОЛНЫЙ публичный URL
-- аватарки (getPublicUrl), поэтому после переноса данных 1:1 в базе остались
-- ссылки вида https://lyvarbqquvgxufmqgyix.supabase.co/storage/v1/object/public/...
-- Пока облачный проект жив, они открываются, после его отключения — нет.
-- Файлы в Storage перенесены, путь внутри /storage/v1/ тот же — меняем только хост.
--
-- Обходит все текстовые колонки схемы public и заменяет старый хост на новый.
-- Идемпотентно: повторный запуск ничего не меняет. В NOTICE — сколько строк
-- исправлено в какой колонке.

do $$
declare
  old_host constant text := 'https://lyvarbqquvgxufmqgyix.supabase.co';
  new_host constant text := 'https://api.base40.fit';
  col record;
  n bigint;
begin
  for col in
    select c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public'
      and t.table_type = 'BASE TABLE'
      and c.data_type in ('text', 'character varying')
  loop
    execute format(
      'update public.%I set %I = replace(%I, $1, $2) where %I like $3',
      col.table_name, col.column_name, col.column_name, col.column_name
    ) using old_host, new_host, '%' || old_host || '%';
    get diagnostics n = row_count;
    if n > 0 then
      raise notice '%.%: исправлено строк — %', col.table_name, col.column_name, n;
    end if;
  end loop;
end $$;
