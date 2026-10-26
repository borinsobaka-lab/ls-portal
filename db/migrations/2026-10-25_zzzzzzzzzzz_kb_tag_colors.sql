-- Цвет тега базы знаний (решение владельца 2026-10-25): выбирается из
-- готового набора при создании и правке тега; текст тега — этим цветом,
-- подложка — светлый тон того же цвета (рисует админка, lib/kb/tags.ts).
-- Хранится ключ набора; null — серый, как у тегов до этой миграции.
alter table public.kb_tags add column if not exists color text;
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'kb_tags_color_check' and conrelid = 'public.kb_tags'::regclass
  ) then
    alter table public.kb_tags
      add constraint kb_tags_color_check check (
        color in ('gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink')
      );
  end if;
end;
$$;
