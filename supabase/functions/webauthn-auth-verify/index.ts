import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { verifyAuthenticationResponse } from "jsr:@simplewebauthn/server@13";

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

function toBytes(b64: string) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) return json({ error: "Missing authorization" }, 401);

    const { response } = await req.json();
    if (!response?.id) return json({ error: "Missing WebAuthn response" }, 400);

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
      .eq("type", "authentication")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!challengeRow) {
      return json({ error: "Confirmation expired — please try again." }, 400);
    }

    const { data: credRow } = await supabaseAdmin
      .from("webauthn_credentials")
      .select("*")
      .eq("user_id", user.id)
      .eq("credential_id", response.id)
      .maybeSingle();

    if (!credRow) {
      await supabaseAdmin.from("webauthn_challenges").delete().eq("id", challengeRow.id);
      return json({ error: "That device isn't registered to this account." }, 400);
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: credRow.credential_id,
        publicKey: toBytes(credRow.public_key),
        counter: credRow.counter,
      },
    });

    await supabaseAdmin.from("webauthn_challenges").delete().eq("id", challengeRow.id);

    if (!verification.verified) {
      return json({ error: "Could not verify — try again or use your PIN." }, 401);
    }

    // Required bookkeeping: keep the stored signature counter moving forward
    // so a cloned authenticator can be detected on a future attempt.
    await supabaseAdmin
      .from("webauthn_credentials")
      .update({ counter: verification.authenticationInfo.newCounter })
      .eq("id", credRow.id);

    return json({ success: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
