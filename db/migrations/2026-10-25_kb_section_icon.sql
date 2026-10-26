-- База знаний: своя иконка у раздела (решение владельца 2026-10-25).
--
-- Раздел — папка верхнего уровня базы; в меню он с иконкой и полужирный,
-- всё внутри — без иконок. Иконку выбирают при создании и в «Названии и
-- описании» папки. Хранится ключ из набора админки (lib/kb/icons.ts,
-- KB_SECTION_ICONS); null — обычная папка. У вложенной папки ключ может
-- остаться после переноса, но не показывается — вернётся наверх, иконка
-- вернётся с ней. Пишут те же политики, что и прочие поля строки
-- («kb_nodes editor write»).

alter table public.kb_nodes add column if not exists icon text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'kb_nodes_icon_check' and conrelid = 'public.kb_nodes'::regclass
  ) then
    alter table public.kb_nodes
      add constraint kb_nodes_icon_check
      check (icon is null or (kind = 'folder' and icon ~ '^[a-z0-9-]{1,32}$'));
  end if;
end;
$$;
