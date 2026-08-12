-- Backs the "Rota Tap" feature: a sender authorizes an amount with their PIN
-- or biometric (creating a pending row here), then hands off a claim link
-- via NFC tap or QR code. The receiver doesn't need to be signed in to see
-- the preview, but does need a Rota account for the money to land in — the
-- edge functions enforce that; this migration just holds the pending state
-- and locks down who can read it directly.

create table if not exists tap_transfers (
  id uuid primary key default gen_random_uuid(),
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  sender_wallet_id uuid not null references dva_wallets(id) on delete cascade,
  amount numeric not null check (amount > 0),
  token text not null unique,
  status text not null default 'pending' check (status in ('pending', 'claimed', 'expired', 'cancelled')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_by_user_id uuid references auth.users(id),
  claimed_wallet_id uuid references dva_wallets(id),
  claimed_at timestamptz
);

create index if not exists tap_transfers_token_idx on tap_transfers (token);
create index if not exists tap_transfers_sender_idx on tap_transfers (sender_user_id);

alter table tap_transfers enable row level security;

-- Reads only, and only the sender's own transfers (so they can watch a
-- "waiting for them to accept..." status). All writes go through the edge
-- functions on the service role — there's no insert/update/delete policy
-- here on purpose, same pattern as dva_wallets.
drop policy if exists "Users can view their own sent tap transfers" on tap_transfers;
create policy "Users can view their own sent tap transfers"
  on tap_transfers for select
  using (auth.uid() = sender_user_id);
