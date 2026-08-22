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

function naira(n: number) {
  return `₦${Number(n).toLocaleString("en-NG")}`;
}

async function sendPush(userId: string, title: string, body: string, data?: Record<string, string>) {
  try {
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/send-push`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId, title, body, data }),
    });
  } catch (_e) {
    // notification is best-effort
  }
}

// Data-only push (no "notification" block) so Android never auto-displays a
// generic system notification for this — RotaMessagingService.kt handles it
// natively and shows the real Accept/Decline banner instead, the same one
// a local NFC read would have shown. Works even with the app fully closed.
async function sendQuickAcceptPush(userId: string, token: string, amount: number, senderName: string) {
  try {
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/send-push`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId,
        title: `${naira(amount)} incoming`,
        body: `From ${senderName} — tap Accept to receive it`,
        data: { type: "tap_quick_accept", token, amount: String(amount), senderName },
        dataOnly: true,
      }),
    });
  } catch (_e) {
    // notification is best-effort
  }
}

// Same reasoning as sendQuickAcceptPush: data-only so RotaMessagingService
// is the only thing that shows UI for it, this time via a full-screen-intent
// notification that opens the Accept screen directly instead of only a
// generic system notification the receiver has to tap first.
async function sendOpenAppPush(userId: string, token: string, amount: number, senderName: string) {
  try {
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/send-push`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId,
        title: `${naira(amount)} incoming`,
        body: `From ${senderName} — opening Rota to accept it`,
        data: { type: "tap_open_app", token, amount: String(amount), senderName },
        dataOnly: true,
      }),
    });
  } catch (_e) {
    // notification is best-effort
  }
}

function demoAccountNumber() {
  let n = "90";
  for (let i = 0; i < 8; i++) n += Math.floor(Math.random() * 10);
  return n;
}

// The sender's phone reads the receiver's passively-broadcast NFC identity
// (their tap_receive_token — safe to broadcast constantly, since it only
// identifies who to pay, not any way to move money out) and calls this
// directly. No claim step needed: the sender already authorized the amount
// with their PIN/biometric before tapping. What happens next depends on the
// RECEIVER's own Rota Tap: Alerts preference, not anything the sender chose.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const { amount, receiveToken, sessionTransferId } = await req.json();
    const amt = Number(amount);
    if (!(amt > 0)) return json({ error: "Enter an amount to send." }, 400);
    if (!receiveToken) return json({ error: "Couldn't read that tap." }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Not signed in" }, 401);
    const senderId = userData.user.id;

    const { data: receiverProfile, error: receiverErr } = await supabaseAdmin
      .from("profiles")
      .select("id, name, avatar_url, tap_receive_mode")
      .eq("tap_receive_token", receiveToken)
      .maybeSingle();
    if (receiverErr || !receiverProfile) return json({ error: "That phone isn't set up to receive Rota Tap." }, 404);
    if (receiverProfile.id === senderId) return json({ error: "You can't send to your own phone." }, 400);

    const { data: senderWallet, error: senderWalletErr } = await supabaseAdmin
      .from("dva_wallets")
      .select("id, balance")
      .eq("user_id", senderId)
      .maybeSingle();
    if (senderWalletErr || !senderWallet) return json({ error: "No wallet found for your account." }, 404);
    if (amt > Number(senderWallet.balance)) return json({ error: "Insufficient balance." }, 400);

    const { data: senderProfile } = await supabaseAdmin
      .from("profiles")
      .select("name")
      .eq("id", senderId)
      .maybeSingle();
    const senderName = senderProfile?.name || "A Rota user";
    const receiverName = receiverProfile.name || "A Rota user";

    // TapSendSheet shows a QR code (a second, independent claim path) at
    // the same time it's listening for this NFC tap — without this, both
    // could be completed from the one PIN authorization: a bystander
    // scanning the QR and the intended NFC recipient could each walk away
    // with the money. Passing the QR transfer's id here lets the two share
    // a fate: whichever path succeeds first atomically expires the other,
    // and this same check rejects the tap outright if the QR side already
    // won that race. The .eq("status", "pending") makes this safe against
    // a real concurrent claim too, not just a client-side timing issue —
    // Postgres only lets one of two racing conditional updates on the same
    // row actually match.
    if (sessionTransferId) {
      const { data: expired, error: expireErr } = await supabaseAdmin
        .from("tap_transfers")
        .update({ status: "expired" })
        .eq("id", sessionTransferId)
        .eq("sender_user_id", senderId)
        .eq("status", "pending")
        .select("id");
      if (expireErr) return json({ error: "Unexpected server error" }, 500);
      if (!expired || expired.length === 0) {
        return json({ error: "This transfer was already completed." }, 409);
      }
    }

    // quick_accept and open_app both leave the money where it is until the
    // receiver acts — same pending-transfer shape tap-transfer-create already
    // uses, just pushed to a specific person instead of handed out as a QR.
    if (receiverProfile.tap_receive_mode !== "auto_accept") {
      const claimToken = crypto.randomUUID().replace(/-/g, "");
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from("tap_transfers")
        .insert({
          sender_user_id: senderId,
          sender_wallet_id: senderWallet.id,
          receiver_user_id: receiverProfile.id,
          amount: amt,
          token: claimToken,
          status: "pending",
          expires_at: expiresAt,
        })
        .select()
        .single();
      if (insertErr) return json({ error: "Could not start this transfer." }, 500);

      if (receiverProfile.tap_receive_mode === "open_app") {
        sendOpenAppPush(receiverProfile.id, claimToken, amt, senderName);
      } else {
        sendQuickAcceptPush(receiverProfile.id, claimToken, amt, senderName);
      }

      return json({ ok: true, status: "pending", id: inserted.id, token: claimToken, expiresAt });
    }

    // auto_accept: the receiver has already said they don't want a
    // confirmation step, so this call is the whole transaction.
    let receiverWallet: { id: string; balance: number } | null = null;
    const { data: existingReceiverWallet } = await supabaseAdmin
      .from("dva_wallets")
      .select("id, balance")
      .eq("user_id", receiverProfile.id)
      .maybeSingle();
    if (existingReceiverWallet) {
      receiverWallet = existingReceiverWallet;
    } else {
      const { data: created, error: createErr } = await supabaseAdmin
        .from("dva_wallets")
        .insert({
          user_id: receiverProfile.id,
          virtual_account_number: demoAccountNumber(),
          virtual_account_bank_name: "Wema Bank (Preview)",
          virtual_account_bank_slug: "wema-bank",
          status: "demo",
          balance: 0,
        })
        .select("id, balance")
        .single();
      if (createErr || !created) return json({ error: "Could not set up their wallet." }, 500);
      receiverWallet = created;
    }

    const newSenderBalance = Number(senderWallet.balance) - amt;
    const newReceiverBalance = Number(receiverWallet.balance) + amt;
    const reference = `TAP-${Date.now().toString(36).toUpperCase()}`;

    const { error: debitErr } = await supabaseAdmin
      .from("dva_wallets")
      .update({ balance: newSenderBalance })
      .eq("id", senderWallet.id)
      .eq("balance", senderWallet.balance);
    if (debitErr) return json({ error: "Could not complete this transfer — try again." }, 500);

    const { error: creditErr } = await supabaseAdmin
      .from("dva_wallets")
      .update({ balance: newReceiverBalance })
      .eq("id", receiverWallet.id);
    if (creditErr) {
      await supabaseAdmin.from("dva_wallets").update({ balance: senderWallet.balance }).eq("id", senderWallet.id);
      return json({ error: "Could not complete this transfer — try again." }, 500);
    }

    await supabaseAdmin.from("dva_wallet_transactions").insert([
      {
        wallet_id: senderWallet.id,
        type: "debit",
        amount: amt,
        counterparty_name: receiverName,
        description: `Rota Tap to ${receiverName}`,
        reference,
      },
      {
        wallet_id: receiverWallet.id,
        type: "credit",
        amount: amt,
        counterparty_name: senderName,
        description: `Rota Tap from ${senderName}`,
        reference,
      },
    ]);

    sendPush(receiverProfile.id, "Money received", `You received ${naira(amt)} via Rota Tap from ${senderName}.`);

    return json({
      ok: true,
      status: "completed",
      amount: amt,
      receiverName,
      receiverAvatarUrl: receiverProfile.avatar_url || null,
      newBalance: newSenderBalance,
    });
  } catch (_e) {
    return json({ error: "Unexpected server error" }, 500);
  }
});
