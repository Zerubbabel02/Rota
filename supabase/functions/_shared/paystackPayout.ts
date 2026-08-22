// Shared by payments-create-funded, payments-mark-paid, and
// run-scheduled-payments — the three places that either pull money in from
// a linked card or push it out to a recipient's bank account via Paystack.

export async function chargeCard(
  paystackSecretKey: string,
  authorizationCode: string,
  email: string,
  amountNaira: number
): Promise<{ ok: true; reference: string } | { ok: false; error: string }> {
  const chargeRes = await fetch("https://api.paystack.co/transaction/charge_authorization", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${paystackSecretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      authorization_code: authorizationCode,
      email,
      amount: Math.round(amountNaira * 100),
    }),
  });
  const chargeData = await chargeRes.json();
  const chargeSuccess = chargeRes.ok && chargeData.status && chargeData.data?.status === "success";
  if (!chargeSuccess) {
    return { ok: false, error: chargeData.data?.gateway_response || chargeData.message || "Charge failed" };
  }
  return { ok: true, reference: chargeData.data?.reference || "" };
}

export async function payOutToRecipient(
  paystackSecretKey: string,
  amountNaira: number,
  recipient: { name: string; accountNumber: string; bankCode: string },
  existingRecipientCode: string | null,
  reason: string
): Promise<{ ok: true; reference: string; recipientCode: string } | { ok: false; error: string }> {
  try {
    let recipientCode = existingRecipientCode;
    if (!recipientCode) {
      const recipientRes = await fetch("https://api.paystack.co/transferrecipient", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paystackSecretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "nuban",
          name: recipient.name,
          account_number: recipient.accountNumber,
          bank_code: recipient.bankCode,
          currency: "NGN",
        }),
      });
      const recipientData = await recipientRes.json();
      if (!recipientRes.ok || !recipientData.status) {
        return { ok: false, error: recipientData.message || "Could not register recipient" };
      }
      recipientCode = recipientData.data.recipient_code;
    }

    const transferRes = await fetch("https://api.paystack.co/transfer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${paystackSecretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: "balance",
        amount: Math.round(amountNaira * 100),
        recipient: recipientCode,
        reason,
      }),
    });
    const transferData = await transferRes.json();
    if (!transferRes.ok || !transferData.status) {
      return { ok: false, error: transferData.message || "Transfer failed", recipientCode } as unknown as { ok: false; error: string };
    }

    return {
      ok: true,
      reference: transferData.data?.reference || transferData.data?.transfer_code || "",
      recipientCode: recipientCode as string,
    };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

// Debits or credits either wallet column (Home's "balance" or the
// separately-tracked "schedule_balance") with an optimistic-concurrency
// guard (only succeeds if the column is still what the caller last read).
// logTxn is false for schedule_balance moves that don't touch Home's own
// balance — nothing to show on Home's activity feed if Home wasn't touched.
// deno-lint-ignore no-explicit-any
export async function adjustWalletColumn(
  supabaseAdmin: any,
  walletId: string,
  column: "balance" | "schedule_balance",
  currentValue: number,
  deltaNaira: number,
  txn: { type: "credit" | "debit"; counterparty_name?: string | null; description?: string | null; reference: string } | null
): Promise<{ ok: true; newValue: number } | { ok: false; error: string }> {
  const newValue = Number(currentValue) + deltaNaira;
  if (newValue < 0) return { ok: false, error: column === "schedule_balance" ? "Insufficient Schedule Balance" : "Insufficient wallet balance" };

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("dva_wallets")
    .update({ [column]: newValue })
    .eq("id", walletId)
    .eq(column, currentValue)
    .select("id");
  if (updateErr) return { ok: false, error: "Could not update wallet balance" };
  if (!updated || updated.length === 0) return { ok: false, error: "Balance changed — try again" };

  if (txn) {
    const { error: txnErr } = await supabaseAdmin.from("dva_wallet_transactions").insert({
      wallet_id: walletId,
      type: txn.type,
      amount: Math.abs(deltaNaira),
      counterparty_name: txn.counterparty_name || null,
      description: txn.description || null,
      reference: txn.reference,
    });
    if (txnErr) return { ok: false, error: "Could not record transaction" };
  }

  return { ok: true, newValue };
}
