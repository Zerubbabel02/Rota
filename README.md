# Rota — money, on schedule

A Nigerian scheduled-payments and budgeting web app. Link a debit card, schedule
"Rotas" (Manual or Automatic recurring/one-off payments), track a budget against
a self-reported total balance, and get AI budgeting guidance.

**Live app:** https://rota-app-zerubbabel1.vercel.app

## Stack

- **Frontend:** React + Vite + Tailwind CSS, single-file app at `src/App.jsx`
- **Backend:** Supabase (Postgres + Auth + Edge Functions + Storage)
- **Payments:** Paystack (card charges, transfers, bank resolution)
- **Biometrics:** WebAuthn via `@simplewebauthn/browser` (client) and
  `@simplewebauthn/server` (edge functions, via JSR)

## Project structure

```
src/                        React app (Vite)
  App.jsx                   Entire UI — screens, tabs, sheets, all components
  main.jsx                  Entry point
  supabaseClient.js         Supabase client init
supabase/functions/         Edge functions (Deno), one folder per function
```

## Edge functions

| Function | Purpose | JWT required |
|---|---|---|
| `verify-card-link` | Verifies a Paystack card-link transaction, saves the payment method | Yes |
| `list-banks` | Fetches the live Paystack NUBAN bank list | Yes |
| `resolve-account` | Verifies an account number against a bank (real NIBSS lookup) | Yes |
| `detect-bank` | Guesses the bank from an account number by trying common banks | Yes |
| `run-scheduled-payments` | Cron target — charges card + transfers for due Automatic Rotas | No (uses `x-cron-secret` header instead) |
| `upload-avatar` | Server-side avatar upload (bypasses a client Storage RLS issue) | Yes |
| `get-advice` | Calls the Anthropic API for budgeting guidance | Yes |
| `set-pin` / `verify-pin` | Hash/verify a 4-digit transaction PIN (PBKDF2, server-side only) | Yes |
| `webauthn-register-options` / `-verify` | WebAuthn biometric enrollment | Yes |
| `webauthn-auth-options` / `-verify` | WebAuthn biometric confirmation | Yes |
| `webauthn-status` / `webauthn-unregister` | Check / remove a registered biometric credential | Yes |

## Database (Supabase Postgres)

Tables: `profiles`, `payments`, `todos`, `payment_methods`, `webauthn_credentials`,
`webauthn_challenges`. Key `payments` columns beyond the obvious: `rota_type`
(`manual`/`automatic`), `scheduled_time`, `recipient_*` fields, `paystack_recipient_code`,
`transaction_ref`, `charge_error`.

## Required Supabase secrets (Project Settings → Edge Functions → Secrets)

- `PAYSTACK_SECRET_KEY` — shared by all Paystack-calling functions
- `ANTHROPIC_API_KEY` — for `get-advice`
- `CRON_SECRET` — must match the `x-cron-secret` header the pg_cron job sends

## Cron

A `pg_cron` job (`run-scheduled-payments-hourly`, `0 * * * *`) calls
`run-scheduled-payments` every hour via `pg_net`, so `scheduled_time` on a Rota
is honored to within the hour.

## Known limitations

- **Automatic Rota transfers require a Paystack "Registered Business"** — the
  Transfers API isn't available on the Starter tier. Manual Rotas are unaffected.
- **"Total balance" is self-reported**, not a real linked bank balance — Rota
  never holds customer funds. Turning it into a real balance would need either
  Paystack Dedicated Virtual Accounts (also gated behind Registered Business,
  and still requires care around not becoming a de facto deposit-taker) or
  read-only account-linking (e.g. Mono/Okra) — the latter avoids any custody
  or licensing question entirely.
- **WebAuthn is bound to `rota-app-zerubbabel1.vercel.app`** — moving to a
  custom domain will require re-registering biometric credentials.

## Local development

```bash
npm install
npm run dev
```

You'll need your own Supabase project URL/key in `src/supabaseClient.js`, the
tables/functions above set up, and the secrets listed.

## Deploying

Frontend deploys to Vercel (`vite build` → static output). Edge functions
deploy individually to Supabase, e.g.:

```bash
supabase functions deploy run-scheduled-payments --project-ref <your-ref>
```
