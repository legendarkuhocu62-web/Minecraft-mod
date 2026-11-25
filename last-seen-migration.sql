-- Выполнить один раз в Supabase → SQL Editor → New query → Run
alter table public.profiles
add column if not exists last_seen_at timestamptz;
