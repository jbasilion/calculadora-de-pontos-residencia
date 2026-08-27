-- Estrutura do banco para o fluxo Telegram -> IA -> WordPress
-- Cada notícia crua enviada vira um "rascunho" (draft) que passa por
-- aprovação antes de virar post no WordPress.

create extension if not exists "pgcrypto";

create table if not exists public.news_drafts (
  id                  uuid primary key default gen_random_uuid(),
  chat_id             bigint      not null,          -- de quem veio no Telegram
  source_text         text        not null,          -- notícia crua recebida
  telegram_file_id    text,                           -- id da foto no Telegram
  photo_url           text,                           -- foto no Storage (URL pública)
  title               text,                           -- título gerado pela IA
  body                text,                           -- corpo (HTML) gerado pela IA
  excerpt             text,                           -- resumo/lead gerado
  status              text        not null default 'pending',
                        -- pending | approved | rejected | published | error
  attempts            int         not null default 1, -- quantas vezes a IA reescreveu
  preview_message_id  bigint,                          -- msg de preview no Telegram
  wp_post_id          bigint,                          -- id do post publicado
  wp_post_url         text,                            -- link do post publicado
  error               text,                            -- última mensagem de erro
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists news_drafts_chat_id_idx on public.news_drafts (chat_id);
create index if not exists news_drafts_status_idx  on public.news_drafts (status);

-- Mantém updated_at atualizado
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists news_drafts_set_updated_at on public.news_drafts;
create trigger news_drafts_set_updated_at
  before update on public.news_drafts
  for each row execute function public.set_updated_at();

-- RLS ligado: só o service_role (usado pela Edge Function) acessa.
alter table public.news_drafts enable row level security;
-- Nenhuma policy pública = ninguém além do service_role lê/escreve.
