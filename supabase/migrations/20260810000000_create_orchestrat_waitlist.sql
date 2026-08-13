create table public.orchestrat (
  id bigint generated always as identity primary key,
  email text not null unique,
  created_at timestamptz not null default now(),
  constraint orchestrat_email_normalized check (
    email = lower(btrim(email))
    and char_length(email) between 3 and 254
  )
);

alter table public.orchestrat enable row level security;

revoke all on table public.orchestrat from anon, authenticated;
revoke all on sequence public.orchestrat_id_seq from anon, authenticated;

grant insert (email) on table public.orchestrat to anon;
grant usage on sequence public.orchestrat_id_seq to anon;

create policy "anon can join orchestrat waitlist"
  on public.orchestrat
  for insert
  to anon
  with check (
    email = lower(btrim(email))
    and char_length(email) between 3 and 254
  );
