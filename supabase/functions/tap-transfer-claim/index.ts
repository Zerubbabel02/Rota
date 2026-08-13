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
  let n = "90";
  for (let i = 0; i < 8; i++) n += Math.floor(Math.random() * 10);
  return n;
}

// The receiver must be signed in — money has to land in a specific wallet,
// and Rota can't credit an account that doesn't exist. No PIN/biometric is
// asked here on purpose: the sender already authorized the amount when they
// created the transfer, and accepting money shouldn't require the same
// friction as sending it.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const { token } = await req.json();
    if (!token) return json({ error: "Missing link." }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Not signed in" }, 401);
    const receiverId = userData.user.id;

    const { data: transfer, error: fetchErr } = await supabaseAdmin
      .from("tap_transfers")
      .select("*")
      .eq("token", token)
      .maybeSingle();
    if (fetchErr || !transfer) return json({ error: "This link isn't valid." }, 404);
    if (transfer.status !== "pending") return json({ error: "This transfer is no longer available." }, 400);
    if (new Date(transfer.expires_at) < new Date()) {
      await supabaseAdmin.from("tap_transfers").update({ status: "expired" }).eq("id", transfer.id).eq("status", "pending");
      return json({ error: "This link has expired." }, 400);
    }
    if (transfer.sender_user_id === receiverId) return json({ error: "You can't accept your own transfer." }, 400);

    const amt = Number(transfer.amount);

    const { data: senderWallet, error: senderWalletErr } = await supabaseAdmin
      .from("dva_wallets")
      .select("id, balance")
      .eq("id", transfer.sender_wallet_id)
      .single();
    if (senderWalletErr || !senderWallet) return json({ error: "Sender's wallet could not be found." }, 404);
    if (amt > Number(senderWallet.balance)) {
      return json({ error: "The sender no longer has enough balance for this transfer." }, 400);
    }

    // Get-or-create the receiver's wallet — mirrors dva-get-or-create-wallet,
    // for the case where accepting a Rota Tap is someone's very first action.
    let receiverWallet: { id: string; balance: number } | null = null;
    const { data: existingReceiverWallet } = await supabaseAdmin
      .from("dva_wallets")
      .select("id, balance")
      .eq("user_id", receiverId)
      .maybeSingle();
    if (existingReceiverWallet) {
      receiverWallet = existingReceiverWallet;
    } else {
      const { data: created, error: createErr } = await supabaseAdmin
        .from("dva_wallets")
        .insert({
          user_id: receiverId,
          virtual_account_number: demoAccountNumber(),
          virtual_account_bank_name: "Wema Bank (Preview)",
          virtual_account_bank_slug: "wema-bank",
          status: "demo",
          balance: 0,
        })
        .select("id, balance")
        .single();
      if (createErr || !created) return json({ error: "Could not set up your wallet." }, 500);
      receiverWallet = created;
    }

    const [{ data: senderProfile }, { data: receiverProfile }] = await Promise.all([
      supabaseAdmin.from("profiles").select("name, avatar_url").eq("id", transfer.sender_user_id).maybeSingle(),
      supabaseAdmin.from("profiles").select("name, avatar_url").eq("id", receiverId).maybeSingle(),
    ]);

    // Atomically claim the transfer before touching any money — the extra
    // .eq("status", "pending") means only one concurrent claim can win this
    // update; a second tap on the same link finds zero rows affected and
    // bails out instead of double-spending it. The receiver's name/avatar
    // are snapshotted here so the sender's screen can show who accepted
    // without needing to read another user's profile row directly.
    const { data: claimedRows, error: claimErr } = await supabaseAdmin
      .from("tap_transfers")
      .update({
        status: "claimed",
        claimed_by_user_id: receiverId,
        claimed_wallet_id: receiverWallet.id,
        claimed_at: new Date().toISOString(),
        claimed_by_name: receiverProfile?.name || "A Rota user",
        claimed_by_avatar_url: receiverProfile?.avatar_url || null,
      })
      .eq("id", transfer.id)
      .eq("status", "pending")
      .select();
    if (claimErr || !claimedRows || claimedRows.length === 0) {
      return json({ error: "This transfer was just claimed or expired — refresh and try again." }, 409);
    }

    const newSenderBalance = Number(senderWallet.balance) - amt;
    const newReceiverBalance = Number(receiverWallet.balance) + amt;
    const reference = `TAP-${Date.now().toString(36).toUpperCase()}`;

    const { error: debitErr } = await supabaseAdmin
      .from("dva_wallets")
      .update({ balance: newSenderBalance })
      .eq("id", senderWallet.id);
    const { error: creditErr } = debitErr
      ? { error: null }
      : await supabaseAdmin.from("dva_wallets").update({ balance: newReceiverBalance }).eq("id", receiverWallet.id);

    if (debitErr || creditErr) {
      // Leave the transfer claimable again rather than stranding it in a
      // half-moved state — the sender's balance wasn't touched if the debit
      // itself failed, and we haven't credited anyone yet either way.
      if (!debitErr) await supabaseAdmin.from("dva_wallets").update({ balance: senderWallet.balance }).eq("id", senderWallet.id);
      await supabaseAdmin
        .from("tap_transfers")
        .update({ status: "pending", claimed_by_user_id: null, claimed_wallet_id: null, claimed_at: null })
        .eq("id", transfer.id);
      return json({ error: "Could not complete this transfer — try again." }, 500);
    }

    await supabaseAdmin.from("dva_wallet_transactions").insert([
      {
        wallet_id: senderWallet.id,
        type: "debit",
        amount: amt,
        counterparty_name: receiverProfile?.name || "a Rota user",
        description: `Rota Tap to ${receiverProfile?.name || "a Rota user"}`,
        reference,
      },
      {
        wallet_id: receiverWallet.id,
        type: "credit",
        amount: amt,
        counterparty_name: senderProfile?.name || "a Rota user",
        description: `Rota Tap from ${senderProfile?.name || "a Rota user"}`,
        reference,
      },
    ]);

    return json({ ok: true, amount: amt, senderName: senderProfile?.name || "A Rota user", newBalance: newReceiverBalance });
  } catch (_e) {
    return json({ error: "Unexpected server error" }, 500);
  }
});
