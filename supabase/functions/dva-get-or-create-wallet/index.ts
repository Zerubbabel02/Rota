import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function demoAccountNumber() {
  // Nigerian NUBANs are 10 digits. Prefixed with 90 so it's visually
  // distinguishable as a preview/demo number, never mistaken for a real one.
  let n = "90";
  for (let i = 0; i < 8; i++) n += Math.floor(Math.random() * 10);
  return n;
}

// This is the architecture-preview version of wallet provisioning: it
// attempts the real Paystack Dedicated Virtual Account flow first (the
// exact call production Rota would make), and only falls back to a
// clearly-labeled demo account if that call fails — which today it will,
// since DVAs require a Paystack-registered business. Once registration
// clears, this same function starts returning real Wema/Titan accounts
// with no code change needed.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const paystackSecretKey = Deno.env.get("PAYSTACK_SECRET_KEY");
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    // Single shared demo wallet for this preview (no auth wall — reviewed
    // via a private link) — reuse it if it already exists.
    const { data: existing } = await supabaseAdmin
      .from("dva_wallets")
      .select("*")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (existing) return json({ wallet: existing });

    let accountNumber = "";
    let bankName = "";
    let bankSlug = "";
    let status: "demo" | "active" = "demo";

    if (paystackSecretKey) {
      try {
        // The real single-step DVA assignment call — identical to what
        // production Rota would send per-user at signup.
        const res = await fetch("https://api.paystack.co/dedicated_account/assign", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${paystackSecretKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: "preview-demo@rota.app",
            first_name: "Rota",
            last_name: "Preview",
            phone: "+2348000000000",
            preferred_bank: "wema-bank",
            country: "NG",
          }),
        });
        const data = await res.json();
        if (res.ok && data?.status && data?.data?.dedicated_account?.account_number) {
          accountNumber = data.data.dedicated_account.account_number;
          bankName = data.data.dedicated_account.bank?.name || "Wema Bank";
          bankSlug = "wema-bank";
          status = "active";
        } else {
          throw new Error(data?.message || "DVA assignment not available yet");
        }
      } catch (_e) {
        // Expected today — falls through to the demo account below.
      }
    }

    if (status === "demo") {
      accountNumber = demoAccountNumber();
      bankName = "Wema Bank (Preview)";
      bankSlug = "wema-bank";
    }

    const { data: inserted, error } = await supabaseAdmin
      .from("dva_wallets")
      .insert({
        virtual_account_number: accountNumber,
        virtual_account_bank_name: bankName,
        virtual_account_bank_slug: bankSlug,
        status,
        balance: 0,
      })
      .select()
      .single();
    if (error) return json({ error: "Could not create preview wallet" }, 500);

    return json({ wallet: inserted });
  } catch (_e) {
    return json({ error: "Unexpected server error" }, 500);
  }
});
