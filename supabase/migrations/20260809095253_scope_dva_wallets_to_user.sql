-- Fixes a data-isolation bug with two layers:
--  1. dva-get-or-create-wallet handed out the single oldest row in
--     dva_wallets to every signed-in user, so every new account saw the
--     same balance and transaction history.
--  2. Both tables carry a leftover "_all" policy — USING (true), WITH CHECK
--     (true), granted to `public` — that lets literally anyone (including
--     signed-out/anon clients) read AND write every wallet and every
--     transaction directly, bypassing the edge functions entirely. This is
--     the more serious of the two and is closed here regardless of #1.
--
-- Wallets are now scoped one-per-user, and RLS is tightened to match the
-- pattern already used correctly on payments/todos/profiles in this schema.

alter table dva_wallets
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- One wallet per user. Existing rows (created before this column existed)
-- keep user_id = null and become permanently orphaned/inaccessible below —
-- intentional, since there's no reliable way to know which historical user
-- a pre-fix shared wallet "belonged" to. Everyone gets a fresh wallet on
-- next load.
create unique index if not exists dva_wallets_user_id_unique
  on dva_wallets (user_id)
  where user_id is not null;

drop policy if exists "dva_wallets_all" on dva_wallets;
drop policy if exists "dva_wallet_transactions_all" on dva_wallet_transactions;

-- Reads only; all writes go through the edge functions (service role,
-- which bypasses RLS), so no insert/update/delete policy is granted here.
drop policy if exists "Users can view their own wallet" on dva_wallets;
create policy "Users can view their own wallet"
  on dva_wallets for select
  using (auth.uid() = user_id);

drop policy if exists "Users can view their own wallet transactions" on dva_wallet_transactions;
create policy "Users can view their own wallet transactions"
  on dva_wallet_transactions for select
  using (
    wallet_id in (select id from dva_wallets where user_id = auth.uid())
  );
