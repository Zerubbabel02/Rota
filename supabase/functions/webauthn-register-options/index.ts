import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { generateRegistrationOptions } from "jsr:@simplewebauthn/server@13";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
// WebAuthn credentials are bound to this origin/RP ID — using the stable
// Vercel alias rather than a preview URL so registered credentials keep working.
const RP_ID = "rota-app-zerubbabel1.vercel.app";
const RP_NAME = "Rota";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) return json({ error: "Missing authorization" }, 401);

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
    const user = userData.user;

    const { data: existing } = await supabaseAdmin
      .from("webauthn_credentials")
      .select("credential_id")
      .eq("user_id", user.id);

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: user.email || user.id,
      userID: new TextEncoder().encode(user.id),
      attestationType: "none",
      authenticatorSelection: {
        userVerification: "required", // forces actual biometric/device-unlock, not just "key present"
        residentKey: "preferred",
      },
      excludeCredentials: (existing || []).map((c) => ({ id: c.credential_id })),
    });

    // Clean up stale challenges, then store this one to check the response against.
    await supabaseAdmin.from("webauthn_challenges").delete().lt("expires_at", new Date().toISOString());
    await supabaseAdmin.from("webauthn_challenges").insert({
      user_id: user.id,
      challenge: options.challenge,
      type: "registration",
    });

    return json(options);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
