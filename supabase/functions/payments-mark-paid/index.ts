import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { adjustWalletColumn, payOutToRecipient } from "../_shared/paystackPayout.ts";

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

// "Execute" on a Manual Rota — Manual Rotas can be created as a pure
// proposal with no recipient on file, so this is also where a recipient
// gets collected and verified for the first time if one wasn't saved
// already. Pays out of Schedule Balance (not Home's balance) via the same
// Paystack Transfers call Automatic Rotas use.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const { paymentId, recipient_bank_code, recipient_bank_name, recipient_account_number, recipient_account_name } =
      await req.json();
    if (!paymentId) return json({ error: "Missing paymentId" }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Not signed in" }, 401);
    const userId = userData.user.id;

    const paystackSecretKey = Deno.env.get("PAYSTACK_SECRET_KEY");
    if (!paystackSecretKey) return json({ error: "Server is not configured with a Paystack secret key yet." }, 500);

    let { data: payment, error: paymentErr } = await supabaseAdmin
      .from("payments")
      .select("*")
      .eq("id", paymentId)
      .eq("user_id", userId)
      .maybeSingle();
    if (paymentErr || !payment) return json({ error: "Rota not found." }, 404);
    if (payment.rota_type !== "manual") return json({ error: "This Rota isn't manual." }, 400);
    if (payment.status !== "upcoming") return json({ error: "This Rota has already been resolved." }, 400);

    const hasRecipientOnFile = payment.recipient_bank_code && payment.recipient_account_number && payment.recipient_account_name;
    const hasRecipientSupplied = recipient_bank_code && recipient_account_number && recipient_account_name;
    if (!hasRecipientOnFile && !hasRecipientSupplied) {
      return json({ error: "Add and verify a recipient before executing." }, 400);
    }

    if (hasRecipientSupplied) {
      const { data: updated, error: updateErr } = await supabaseAdmin
        .from("payments")
        .update({
          recipient_bank_code,
          recipient_bank_name: recipient_bank_name || null,
          recipient_account_number,
          recipient_account_name,
        })
        .eq("id", payment.id)
        .select()
        .single();
      if (updateErr || !updated) return json({ error: "Could not save recipient details." }, 500);
      payment = updated;
    }

    const { data: wallet, error: walletErr } = await supabaseAdmin
      .from("dva_wallets")
      .select("id, schedule_balance")
      .eq("user_id", userId)
      .maybeSingle();
    if (walletErr || !wallet) return json({ error: "Wallet not found." }, 404);

    const amt = Number(payment.amount);
    const debitRef = `RM-${Date.now().toString(36).toUpperCase()}`;
    const debitResult = await adjustWalletColumn(supabaseAdmin, wallet.id, "schedule_balance", Number(wallet.schedule_balance), -amt, {
      type: "debit",
      counterparty_name: payment.recipient_account_name,
      description: `Rota payment — ${payment.name}`,
      reference: debitRef,
    });
    if (!debitResult.ok) return json({ error: debitResult.error }, 400);

    const payoutResult = await payOutToRecipient(
      paystackSecretKey,
      amt,
      {
        name: payment.recipient_account_name,
        accountNumber: payment.recipient_account_number,
        bankCode: payment.recipient_bank_code,
      },
      payment.paystack_recipient_code || null,
      payment.name
    );

    if (!payoutResult.ok) {
      // Reverse the debit — the money never actually left, so it goes
      // straight back into Schedule Balance rather than being lost.
      await adjustWalletColumn(supabaseAdmin, wallet.id, "schedule_balance", debitResult.newValue, amt, {
        type: "credit",
        description: `Reversal — ${payment.name} payout failed`,
        reference: `${debitRef}-REV`,
      });
      await supabaseAdmin
        .from("payments")
        .update({ charge_error: (payoutResult as { error: string }).error })
        .eq("id", payment.id);
      return json({ error: (payoutResult as { error: string }).error }, 400);
    }

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from("payments")
      .update({
        status: "paid",
        paid_at: new Date().toISOString(),
        charge_error: null,
        transaction_ref: payoutResult.reference,
        paystack_recipient_code: payoutResult.recipientCode,
      })
      .eq("id", payment.id)
      .select()
      .single();
    if (updateErr || !updated) return json({ error: "Payout sent but the Rota could not be updated. Contact support." }, 500);

    return json({ ok: true, payment: { ...updated, amount: Number(updated.amount) }, scheduleBalance: debitResult.newValue });
  } catch (_e) {
    return json({ error: "Unexpected server error" }, 500);
  }
});
