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

// Deliberately public (no auth required) — whoever taps or scans a Rota Tap
// link should see who it's from and how much before being asked to sign in.
// Read-only: never touches balances or transfer status.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const { token } = await req.json();
    if (!token) return json({ ok: false, error: "Missing link." });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const { data: transfer, error } = await supabaseAdmin
      .from("tap_transfers")
      .select("amount, status, expires_at, sender_user_id")
      .eq("token", token)
      .maybeSingle();
    if (error || !transfer) return json({ ok: false, error: "This link isn't valid." });

    const isExpired = transfer.status === "pending" && new Date(transfer.expires_at) < new Date();
    if (isExpired) return json({ ok: false, error: "This link has expired.", status: "expired" });
    if (transfer.status === "claimed") {
      return json({ ok: false, error: "This transfer has already been accepted.", status: "claimed" });
    }
    if (transfer.status !== "pending") {
      return json({ ok: false, error: "This link is no longer valid.", status: transfer.status });
    }

    const { data: senderProfile } = await supabaseAdmin
      .from("profiles")
      .select("name")
      .eq("id", transfer.sender_user_id)
      .maybeSingle();

    return json({
      ok: true,
      amount: Number(transfer.amount),
      senderName: senderProfile?.name || "A Rota user",
      status: "pending",
    });
  } catch (_e) {
    return json({ ok: false, error: "Unexpected server error" });
  }
});
