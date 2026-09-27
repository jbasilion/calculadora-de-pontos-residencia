-- Esquema do bot assessor. Aplique no SQL Editor do Supabase ou via `supabase db push`.
create extension if not exists pgcrypto;

create table if not exists public.users (
  id          uuid primary key default gen_random_uuid(),
  chat_id     text not null unique,          -- id do chat no Telegram (usuário ou grupo)
  name        text,
  tz          text not null default 'America/Sao_Paulo',
  created_at  timestamptz not null default now()
);

create table if not exists public.messages (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.users(id) on delete cascade,
  role        text not null check (role in ('user','assistant')),
  content     text not null,
  created_at  timestamptz not null default now()
);
create index if not exists messages_user_created_idx on public.messages(user_id, created_at desc);

create table if not exists public.transactions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  kind            text not null check (kind in ('gasto','receita')),
  amount          numeric(14,2) not null check (amount >= 0),
  description     text not null,
  category        text,
  payment_method  text,
  occurred_on     date not null,
  created_at      timestamptz not null default now()
);
create index if not exists transactions_user_date_idx on public.transactions(user_id, occurred_on desc);

create table if not exists public.reminders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  kind        text not null check (kind in ('lembrete','compromisso')),
  title       text not null,
  location    text,
  due_at      timestamptz not null,
  remind_at   timestamptz not null,
  recurrence  text not null default 'nenhuma' check (recurrence in ('nenhuma','diaria','semanal','mensal')),
  status      text not null default 'pendente' check (status in ('pendente','enviado','cancelado')),
  created_at  timestamptz not null default now()
);
create index if not exists reminders_due_idx on public.reminders(status, remind_at);
create index if not exists reminders_user_idx on public.reminders(user_id, due_at);

create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  text        text not null,
  created_at  timestamptz not null default now()
);

-- Idempotência: o Telegram pode reentregar uma mesma atualização.
create table if not exists public.processed_messages (
  external_id   text primary key,
  created_at    timestamptz not null default now()
);

-- O servidor usa a chave service_role; bloqueia acesso anônimo/autenticado direto.
alter table public.users enable row level security;
alter table public.messages enable row level security;
alter table public.transactions enable row level security;
alter table public.reminders enable row level security;
alter table public.notes enable row level security;
alter table public.processed_messages enable row level security;
