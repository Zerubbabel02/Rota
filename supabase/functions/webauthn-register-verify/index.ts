import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { verifyRegistrationResponse } from "jsr:@simplewebauthn/server@13";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const RP_ID = "rota-app-zerubbabel1.vercel.app";
const ORIGIN = "https://rota-app-zerubbabel1.vercel.app";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function toBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) return json({ error: "Missing authorization" }, 401);

    const { response } = await req.json();
    if (!response) return json({ error: "Missing WebAuthn response" }, 400);

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
    const user = userData.user;

    const { data: challengeRow } = await supabaseAdmin
      .from("webauthn_challenges")
      .select("*")
      .eq("user_id", user.id)
      .eq("type", "registration")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!challengeRow) {
      return json({ error: "Registration expired — please try again." }, 400);
    }

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });

    await supabaseAdmin.from("webauthn_challenges").delete().eq("id", challengeRow.id);

    if (!verification.verified || !verification.registrationInfo) {
      return json({ error: "Could not verify that device." }, 400);
    }

    const { credential } = verification.registrationInfo;
    const { error: insertErr } = await supabaseAdmin.from("webauthn_credentials").insert({
      user_id: user.id,
      credential_id: credential.id,
      public_key: toBase64(credential.publicKey),
      counter: credential.counter,
    });
    if (insertErr) return json({ error: insertErr.message }, 500);

    return json({ success: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
