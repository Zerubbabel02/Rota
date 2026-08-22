import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { hashSecret, saltBytesFromB64 } from "../_shared/secretHash.ts";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const { code } = await req.json();
    if (!code || typeof code !== "string") return json({ error: "Enter the code from your email." }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Not signed in" }, 401);
    const userId = userData.user.id;

    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("phone_otp_hash, phone_otp_salt, phone_otp_expires_at")
      .eq("id", userId)
      .maybeSingle();
    if (profileErr || !profile?.phone_otp_hash || !profile.phone_otp_salt) {
      return json({ error: "No verification in progress — request a new code." }, 400);
    }
    if (!profile.phone_otp_expires_at || new Date(profile.phone_otp_expires_at) < new Date()) {
      return json({ error: "That code has expired — request a new one." }, 400);
    }

    const candidateHash = await hashSecret(code, saltBytesFromB64(profile.phone_otp_salt));
    if (candidateHash !== profile.phone_otp_hash) {
      return json({ error: "Incorrect code." }, 401);
    }

    const { error: updateErr } = await supabaseAdmin
      .from("profiles")
      .update({ phone_verified: true, phone_otp_hash: null, phone_otp_salt: null, phone_otp_expires_at: null })
      .eq("id", userId);
    if (updateErr) return json({ error: "Verified, but could not save. Try again." }, 500);

    return json({ ok: true });
  } catch (_e) {
    return json({ error: "Unexpected server error" }, 500);
  }
});
