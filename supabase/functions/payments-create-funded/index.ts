import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { chargeCard } from "../_shared/paystackPayout.ts";

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

// Creates a Rota (manual or automatic) and, in the same call, actually funds
// it: charges the linked card right away and moves that amount into the
// wallet balance, marked reserved (via charged_at) so it's set aside from
// what Home shows as available. Nothing is created at all if the charge
// fails — there's no such thing as an unfunded row from this path, since
// every Manual Rota and every "fund now" Automatic Rota needs the money to
// actually be sitting in the wallet before it can be scheduled.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const {
      name,
      amount,
      date,
      scheduled_time,
      category,
      rota_type,
      fund_timing,
      recipient_bank_code,
      recipient_bank_name,
      recipient_account_number,
      recipient_account_name,
    } = await req.json();

    const amt = Number(amount);
    if (!name || typeof name !== "string" || !name.trim()) return json({ error: "Enter a name for this Rota." }, 400);
    if (!(amt > 0)) return json({ error: "Enter an amount." }, 400);
    if (!date) return json({ error: "Pick a date." }, 400);
    if (!["manual", "automatic"].includes(rota_type)) return json({ error: "Invalid Rota type." }, 400);
    if (!recipient_bank_code || !recipient_account_number || !recipient_account_name) {
      return json({ error: "Add and verify a recipient before saving." }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Not signed in" }, 401);
    const userId = userData.user.id;
    const email = userData.user.email;
    if (!email) return json({ error: "Your account has no email on file." }, 400);

    const paystackSecretKey = Deno.env.get("PAYSTACK_SECRET_KEY");
    if (!paystackSecretKey) return json({ error: "Server is not configured with a Paystack secret key yet." }, 500);

    const { data: method } = await supabaseAdmin
      .from("payment_methods")
      .select("paystack_authorization_code")
      .eq("user_id", userId)
      .maybeSingle();
    if (!method?.paystack_authorization_code) {
      return json({ error: "Link a card in Profile before scheduling a funded Rota." }, 400);
    }

    const { data: wallet, error: walletErr } = await supabaseAdmin
      .from("dva_wallets")
      .select("id, balance")
      .eq("user_id", userId)
      .maybeSingle();
    if (walletErr || !wallet) return json({ error: "Set up your wallet on Home before scheduling a Rota." }, 400);

    const chargeResult = await chargeCard(paystackSecretKey, method.paystack_authorization_code, email, amt);
    if (!chargeResult.ok) return json({ error: chargeResult.error }, 400);

    const nowIso = new Date().toISOString();
    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from("payments")
      .insert({
        user_id: userId,
        name: name.trim(),
        amount: amt,
        date,
        scheduled_time: scheduled_time || "09:00:00",
        category,
        status: "upcoming",
        rota_type,
        fund_timing: rota_type === "automatic" ? (fund_timing || "now") : null,
        charged_at: nowIso,
        recipient_bank_code,
        recipient_bank_name: recipient_bank_name || null,
        recipient_account_number,
        recipient_account_name,
      })
      .select()
      .single();
    if (insertErr || !inserted) {
      // The card is already charged at this point — surface a distinct
      // message rather than a generic failure, since this needs a human to
      // look at it (the money left the card but the Rota never got created).
      return json({ error: "Card was charged but the Rota could not be saved. Contact support." }, 500);
    }

    const { data: updatedWallet, error: updateErr } = await supabaseAdmin
      .from("dva_wallets")
      .update({ balance: Number(wallet.balance) + amt })
      .eq("id", wallet.id)
      .eq("balance", wallet.balance)
      .select("balance")
      .single();
    if (updateErr || !updatedWallet) {
      return json({ error: "Card was charged but the wallet could not be updated. Contact support." }, 500);
    }

    await supabaseAdmin.from("dva_wallet_transactions").insert({
      wallet_id: wallet.id,
      type: "credit",
      amount: amt,
      description: `Card charge for "${name.trim()}"`,
      reference: chargeResult.reference || `FUND-${Date.now().toString(36).toUpperCase()}`,
    });

    return json({ ok: true, payment: { ...inserted, amount: Number(inserted.amount) }, walletBalance: Number(updatedWallet.balance) });
  } catch (_e) {
    return json({ error: "Unexpected server error" }, 500);
  }
});
