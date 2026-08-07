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

// 'credit' stands in for what a Paystack DVA webhook (charge.success on the
// dedicated account) would do automatically in production when someone
// transfers money in from any Nigerian bank.
// 'debit' stands in for a scheduled Rota executing by drawing on the wallet
// balance instead of charging a linked card — in production this would call
// Paystack's Transfers API to actually send the money out.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const { wallet_id, action, amount, counterparty_name, counterparty_bank, description } = await req.json();
    if (!wallet_id || !["credit", "debit"].includes(action) || !(Number(amount) > 0)) {
      return json({ error: "Missing or invalid parameters" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const { data: wallet, error: fetchErr } = await supabaseAdmin
      .from("dva_wallets")
      .select("*")
      .eq("id", wallet_id)
      .single();
    if (fetchErr || !wallet) return json({ error: "Wallet not found" }, 404);

    const amt = Number(amount);
    if (action === "debit" && amt > Number(wallet.balance)) {
      return json({ error: "Insufficient wallet balance for this scheduled payment" }, 400);
    }

    const newBalance = action === "credit" ? Number(wallet.balance) + amt : Number(wallet.balance) - amt;
    const reference = `${action === "credit" ? "DVA-IN" : "DVA-OUT"}-${Date.now().toString(36).toUpperCase()}`;

    const { error: updateErr } = await supabaseAdmin
      .from("dva_wallets")
      .update({ balance: newBalance })
      .eq("id", wallet_id);
    if (updateErr) return json({ error: "Could not update wallet balance" }, 500);

    const { data: txn, error: txnErr } = await supabaseAdmin
      .from("dva_wallet_transactions")
      .insert({
        wallet_id,
        type: action,
        amount: amt,
        counterparty_name: counterparty_name || null,
        counterparty_bank: counterparty_bank || null,
        description: description || null,
        reference,
      })
      .select()
      .single();
    if (txnErr) return json({ error: "Could not record transaction" }, 500);

    return json({ balance: newBalance, transaction: txn });
  } catch (_e) {
    return json({ error: "Unexpected server error" }, 500);
  }
});
