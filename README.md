# Rota

Nigerian scheduled-payments / budgeting web app.

This is the unified codebase: the real Rota app merged with the
Dedicated Virtual Account (DVA) wallet work previously prototyped in a
separate `rota-dva-preview` project. Every user's Home tab now shows a
real wallet balance with Add Money / Send Money — this is no longer a
separate preview, it's part of the app.

## Stack
- Vite + React (src/)
- Tailwind CSS
- Supabase — auth, database, and 17 edge functions (supabase/functions/)
- Paystack — card linking, charges, and (pending business registration)
  Dedicated Virtual Accounts
- WebAuthn — biometric confirm

## Getting started
```bash
npm install
npm run dev
```

## Deploying
- **Frontend**: deploys to the Vercel project `rota-app`, aliased at
  `rota-app-zerubbabel1.vercel.app`. Deploys should target `production`.
- **Edge functions**: deploy via the Supabase CLI or dashboard to
  project `szwlaxrsqqqlptmddgjs`.

## What changed in this merge
- Home tab: real wallet balance, Add Money (bank transfer, card top-up,
  USSD, QR), Send Money (bank-detect + review + PIN/biometric confirm),
  and per-day transaction history — replacing the old manually-set
  "total balance" field.
- Mobile layout fix: the bottom tab bar is now pinned to the viewport
  instead of scrolling up with the page.
- Bottom sheets (bank picker, PIN entry, send flow) now lift above the
  on-screen keyboard on mobile instead of being covered by it.

## Known open items (as of this merge)
- Paystack account is not yet on "Registered Business" status — this
  blocks *real* Dedicated Virtual Accounts, Automatic Rota, and Direct
  Debit. Until then, `dva-get-or-create-wallet` issues a labeled demo
  account (same code path activates automatically once verified).
- The `rota-dva-preview` Vercel project can be retired now that this
  is merged in — nothing further should be deployed there.
- No prior GitHub push for this app was ever confirmed complete —
  treat this export as the actual source of truth, not any existing
  remote history.
