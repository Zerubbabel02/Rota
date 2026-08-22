import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { hashSecret, randomSaltB64, saltBytesFromB64 } from "../_shared/secretHash.ts";

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

// Sends a 6-digit code to the signed-in user's own account email to prove
// they own the phone number they just entered — no SMS provider needed,
// since the code goes to an address they've already verified by signing up.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Not signed in" }, 401);
    const userId = userData.user.id;
    const email = userData.user.email;
    if (!email) return json({ error: "Your account has no email on file." }, 400);

    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("phone")
      .eq("id", userId)
      .maybeSingle();
    if (profileErr || !profile?.phone) return json({ error: "Save a phone number first." }, 400);

    // No email-sending provider configured yet — fail honestly rather than
    // storing a code the user will never actually receive.
    const emailApiKey = Deno.env.get("EMAIL_PROVIDER_API_KEY");
    if (!emailApiKey) {
      return json({ error: "Email verification isn't set up yet — an email-sending provider needs to be connected first." }, 500);
    }

    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
    const saltB64 = randomSaltB64();
    const hash = await hashSecret(code, saltBytesFromB64(saltB64));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error: updateErr } = await supabaseAdmin
      .from("profiles")
      .update({ phone_otp_hash: hash, phone_otp_salt: saltB64, phone_otp_expires_at: expiresAt })
      .eq("id", userId);
    if (updateErr) return json({ error: "Could not start verification." }, 500);

    // Actual send call goes here once EMAIL_PROVIDER_API_KEY exists — e.g.
    // a POST to Resend/SendGrid with `code` and `email` in the template.

    return json({ ok: true });
  } catch (_e) {
    return json({ error: "Unexpected server error" }, 500);
  }
});
