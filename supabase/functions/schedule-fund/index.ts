import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { adjustWalletColumn, chargeCard } from "../_shared/paystackPayout.ts";

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

// Tops up Schedule Balance — the separately-tracked pot Rotas draw from at
// execution — either by moving money that's already in the Home balance
// (pure internal move, no Paystack involved) or by charging the linked
// card straight into it (Home's own balance never touched either way).
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const { source, amount } = await req.json();
    const amt = Number(amount);
    if (!(amt > 0)) return json({ error: "Enter an amount." }, 400);
    if (!["home", "card"].includes(source)) return json({ error: "Invalid funding source." }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Not signed in" }, 401);
    const userId = userData.user.id;

    const { data: wallet, error: walletErr } = await supabaseAdmin
      .from("dva_wallets")
      .select("id, balance, schedule_balance")
      .eq("user_id", userId)
      .maybeSingle();
    if (walletErr || !wallet) return json({ error: "Set up your wallet on Home first." }, 400);

    if (source === "home") {
      const debitResult = await adjustWalletColumn(supabaseAdmin, wallet.id, "balance", Number(wallet.balance), -amt, {
        type: "debit",
        description: "Moved to Schedule Balance",
        reference: `SCHFUND-${Date.now().toString(36).toUpperCase()}`,
      });
      if (!debitResult.ok) return json({ error: debitResult.error }, 400);

      const creditResult = await adjustWalletColumn(
        supabaseAdmin,
        wallet.id,
        "schedule_balance",
        Number(wallet.schedule_balance),
        amt,
        null
      );
      if (!creditResult.ok) {
        // Put it back — the move never actually completed.
        await adjustWalletColumn(supabaseAdmin, wallet.id, "balance", debitResult.newValue, amt, {
          type: "credit",
          description: "Reversal — Schedule Balance move failed",
          reference: `SCHFUND-REV-${Date.now().toString(36).toUpperCase()}`,
        });
        return json({ error: creditResult.error }, 400);
      }

      return json({ ok: true, balance: debitResult.newValue, scheduleBalance: creditResult.newValue });
    }

    // source === "card"
    const paystackSecretKey = Deno.env.get("PAYSTACK_SECRET_KEY");
    if (!paystackSecretKey) return json({ error: "Server is not configured with a Paystack secret key yet." }, 500);

    const { data: method } = await supabaseAdmin
      .from("payment_methods")
      .select("paystack_authorization_code")
      .eq("user_id", userId)
      .maybeSingle();
    if (!method?.paystack_authorization_code) {
      return json({ error: "Link a card in Profile before funding from card." }, 400);
    }
    const email = userData.user.email;
    if (!email) return json({ error: "Your account has no email on file." }, 400);

    const chargeResult = await chargeCard(paystackSecretKey, method.paystack_authorization_code, email, amt);
    if (!chargeResult.ok) return json({ error: chargeResult.error }, 400);

    const creditResult = await adjustWalletColumn(
      supabaseAdmin,
      wallet.id,
      "schedule_balance",
      Number(wallet.schedule_balance),
      amt,
      null
    );
    if (!creditResult.ok) {
      // Card was already charged — needs a human, not a silent retry.
      return json({ error: `Card was charged but Schedule Balance could not be credited: ${creditResult.error}. Contact support.` }, 500);
    }

    return json({ ok: true, balance: Number(wallet.balance), scheduleBalance: creditResult.newValue });
  } catch (_e) {
    return json({ error: "Unexpected server error" }, 500);
  }
});
