-- Lets the sender's screen show who accepted a Rota Tap (name + avatar)
-- without opening up cross-user reads on profiles. tap-transfer-claim
-- writes a snapshot of the receiver's name/avatar here at claim time; the
-- sender's existing "view own sent transfers" policy already covers reading
-- these two new columns, so no RLS change is needed.

alter table tap_transfers
  add column if not exists claimed_by_name text,
  add column if not exists claimed_by_avatar_url text;
