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

// Called after the sender has already confirmed with their transaction PIN
// or biometrics (same ConfirmSheet flow Send Money uses) — this just opens
// a 10-minute claim window for that authorized amount. No money moves yet;
// that only happens when someone calls tap-transfer-claim.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const { amount } = await req.json();
    const amt = Number(amount);
    if (!(amt > 0)) return json({ error: "Enter an amount to send." }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Not signed in" }, 401);
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Not signed in" }, 401);
    const userId = userData.user.id;

    const { data: wallet, error: walletErr } = await supabaseAdmin
      .from("dva_wallets")
      .select("id, balance")
      .eq("user_id", userId)
      .maybeSingle();
    if (walletErr || !wallet) return json({ error: "No wallet found for your account." }, 404);
    if (amt > Number(wallet.balance)) return json({ error: "Insufficient balance." }, 400);

    const claimToken = crypto.randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from("tap_transfers")
      .insert({
        sender_user_id: userId,
        sender_wallet_id: wallet.id,
        amount: amt,
        token: claimToken,
        status: "pending",
        expires_at: expiresAt,
      })
      .select()
      .single();
    if (insertErr) return json({ error: "Could not start this transfer." }, 500);

    return json({ ok: true, id: inserted.id, token: claimToken, expiresAt });
  } catch (_e) {
    return json({ error: "Unexpected server error" }, 500);
  }
});
