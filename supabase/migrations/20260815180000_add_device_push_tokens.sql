-- Stores each signed-in device's FCM token so a server-side edge function
-- can push a real notification (send/receive money, etc.) even while the
-- app is closed. A user can have multiple tokens (multiple devices); a
-- token is unique since Firebase reissues a fresh one per app install.
create table if not exists device_push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null unique,
  platform text not null default 'android',
  created_at timestamptz not null default now()
);

create index if not exists device_push_tokens_user_id_idx on device_push_tokens(user_id);

alter table device_push_tokens enable row level security;

create policy "Users manage their own push tokens"
  on device_push_tokens for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
