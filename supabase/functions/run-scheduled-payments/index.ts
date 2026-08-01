import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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

    // Only automatic Rotas are auto-executed. Manual Rotas wait for the user
    // to carry out the transfer themselves and mark it paid in the app.
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

      const { data: method } = await supabaseAdmin
        .from("payment_methods")
        .select("*")
        .eq("user_id", payment.user_id)
        .maybeSingle();

      if (!method?.paystack_authorization_code) {
        results.push({ payment_id: payment.id, outcome: "skipped_no_card" });
        continue;
      }

      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(payment.user_id);
      const email = userData?.user?.email;
      if (!email) {
        results.push({ payment_id: payment.id, outcome: "skipped_no_email" });
        continue;
      }

      // Step 1: pull the funds in by charging the user's linked card.
      // If a prior attempt already charged the card (charged_at is set) but
      // only the transfer step failed, skip charging again on retry — the
      // money is already in — and go straight to the transfer.
      if (!payment.charged_at) {
        const chargeRes = await fetch("https://api.paystack.co/transaction/charge_authorization", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${paystackSecretKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            authorization_code: method.paystack_authorization_code,
            email,
            amount: Math.round(Number(payment.amount) * 100),
          }),
        });
        const chargeData = await chargeRes.json();
        const chargeSuccess = chargeRes.ok && chargeData.status && chargeData.data?.status === "success";

        if (!chargeSuccess) {
          const errMsg = chargeData.data?.gateway_response || chargeData.message || "Charge failed";
          await supabaseAdmin
            .from("payments")
            .update({ status: "failed", charge_error: errMsg })
            .eq("id", payment.id);
          results.push({ payment_id: payment.id, outcome: "charge_failed", error: errMsg });
          continue;
        }
      }

      // Step 2: push the funds out to the designated recipient account.
      try {
        let recipientCode = payment.paystack_recipient_code;
        if (!recipientCode) {
          const recipientRes = await fetch("https://api.paystack.co/transferrecipient", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${paystackSecretKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              type: "nuban",
              name: payment.recipient_account_name || "Recipient",
              account_number: payment.recipient_account_number,
              bank_code: payment.recipient_bank_code,
              currency: "NGN",
            }),
          });
          const recipientData = await recipientRes.json();
          if (!recipientRes.ok || !recipientData.status) {
            throw new Error(recipientData.message || "Could not register recipient");
          }
          recipientCode = recipientData.data.recipient_code;
          await supabaseAdmin
            .from("payments")
            .update({ paystack_recipient_code: recipientCode })
            .eq("id", payment.id);
        }

        const transferRes = await fetch("https://api.paystack.co/transfer", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${paystackSecretKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            source: "balance",
            amount: Math.round(Number(payment.amount) * 100),
            recipient: recipientCode,
            reason: payment.name,
          }),
        });
        const transferData = await transferRes.json();
        if (!transferRes.ok || !transferData.status) {
          throw new Error(transferData.message || "Transfer failed");
        }

        await supabaseAdmin
          .from("payments")
          .update({
            status: "paid",
            charged_at: new Date().toISOString(),
            paid_at: new Date().toISOString(),
            charge_error: null,
            transaction_ref: transferData.data?.reference || transferData.data?.transfer_code || null,
          })
          .eq("id", payment.id);
        results.push({ payment_id: payment.id, outcome: "paid" });
      } catch (transferErr) {
        // Card was already charged, so this needs a clear, distinct message —
        // this is not a simple "retry" situation, it needs a human to look at it.
        await supabaseAdmin
          .from("payments")
          .update({
            status: "failed",
            charged_at: new Date().toISOString(),
            charge_error: `Card was charged but the transfer to the recipient failed: ${String(
              (transferErr as Error).message || transferErr
            )}. Contact support before retrying.`,
          })
          .eq("id", payment.id);
        results.push({ payment_id: payment.id, outcome: "transfer_failed", error: String(transferErr) });
      }
    }

    return json({ processed: results.length, results });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
