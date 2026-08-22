import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { adjustWalletColumn, payOutToRecipient } from "../_shared/paystackPayout.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  try {
    const cronSecret = Deno.env.get("CRON_SECRET");
    const providedSecret = req.headers.get("x-cron-secret");
    if (!cronSecret || providedSecret !== cronSecret) {
      return json({ error: "Unauthorized" }, 401);
    }

    const paystackSecretKey = Deno.env.get("PAYSTACK_SECRET_KEY");
    if (!paystackSecretKey) {
      return json({ error: "Server is not configured with a Paystack secret key yet." }, 500);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const nowUtc = new Date();
    // Nigeria is UTC+1 year-round (no DST) — compute "today" in WAT terms so the
    // date boundary matches what the user sees in the app.
    const nowWAT = new Date(nowUtc.getTime() + 60 * 60 * 1000);
    const todayWAT = nowWAT.toISOString().slice(0, 10);

    // Only automatic Rotas are auto-executed. Manual Rotas are executed by
    // the user tapping Execute (payments-mark-paid).
    // This is a broad candidate filter (date <= today) — the precise
    // date+time cutoff is applied below, since combining a date and time
    // column into one comparison isn't expressible through the query builder.
    const { data: candidates, error: dueErr } = await supabaseAdmin
      .from("payments")
      .select("*")
      .eq("status", "upcoming")
      .eq("rota_type", "automatic")
      .lte("date", todayWAT);

    if (dueErr) return json({ error: dueErr.message }, 500);

    const duePayments = (candidates ?? []).filter((p) => {
      const scheduledTime = p.scheduled_time || "09:00:00";
      const scheduledAt = new Date(`${p.date}T${scheduledTime}+01:00`);
      return scheduledAt.getTime() <= nowUtc.getTime();
    });

    const results: Record<string, unknown>[] = [];

    for (const payment of duePayments) {
      if (!payment.recipient_account_number || !payment.recipient_bank_code) {
        results.push({ payment_id: payment.id, outcome: "skipped_no_recipient" });
        continue;
      }

      const { data: wallet } = await supabaseAdmin
        .from("dva_wallets")
        .select("id, schedule_balance")
        .eq("user_id", payment.user_id)
        .maybeSingle();
      if (!wallet) {
        results.push({ payment_id: payment.id, outcome: "skipped_no_wallet" });
        continue;
      }

      const amt = Number(payment.amount);

      // Pays out of Schedule Balance directly — no card charge here anymore.
      // Rotas draw from whatever's already been funded into Schedule
      // Balance via schedule-fund; if that's not enough, this Rota just
      // fails and waits for a top-up + retry rather than falling back to
      // the card.
      const debitRef = `RS-${Date.now().toString(36).toUpperCase()}`;
      const debitResult = await adjustWalletColumn(supabaseAdmin, wallet.id, "schedule_balance", Number(wallet.schedule_balance), -amt, {
        type: "debit",
        counterparty_name: payment.recipient_account_name,
        description: `Rota payment — ${payment.name}`,
        reference: debitRef,
      });
      if (!debitResult.ok) {
        await supabaseAdmin
          .from("payments")
          .update({ status: "failed", charge_error: debitResult.error })
          .eq("id", payment.id);
        results.push({ payment_id: payment.id, outcome: "insufficient_schedule_balance", error: debitResult.error });
        continue;
      }

      const payoutResult = await payOutToRecipient(
        paystackSecretKey,
        amt,
        {
          name: payment.recipient_account_name || "Recipient",
          accountNumber: payment.recipient_account_number,
          bankCode: payment.recipient_bank_code,
        },
        payment.paystack_recipient_code || null,
        payment.name
      );

      if (!payoutResult.ok) {
        await adjustWalletColumn(supabaseAdmin, wallet.id, "schedule_balance", debitResult.newValue, amt, {
          type: "credit",
          description: `Reversal — ${payment.name} payout failed`,
          reference: `${debitRef}-REV`,
        });
        await supabaseAdmin
          .from("payments")
          .update({
            status: "failed",
            charge_error: `Transfer to the recipient failed: ${
              (payoutResult as { error: string }).error
            }. Contact support before retrying.`,
          })
          .eq("id", payment.id);
        results.push({ payment_id: payment.id, outcome: "transfer_failed", error: (payoutResult as { error: string }).error });
        continue;
      }

      await supabaseAdmin
        .from("payments")
        .update({
          status: "paid",
          paid_at: new Date().toISOString(),
          charge_error: null,
          transaction_ref: payoutResult.reference,
          paystack_recipient_code: payoutResult.recipientCode,
        })
        .eq("id", payment.id);
      results.push({ payment_id: payment.id, outcome: "paid" });
    }

    return json({ processed: results.length, results });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
