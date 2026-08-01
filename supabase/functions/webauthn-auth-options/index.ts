import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { generateAuthenticationOptions } from "jsr:@simplewebauthn/server@13";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const RP_ID = "rota-app-zerubbabel1.vercel.app";

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

    const { data: creds } = await supabaseAdmin
      .from("webauthn_credentials")
      .select("credential_id")
      .eq("user_id", user.id);

    if (!creds || creds.length === 0) {
      return json({ error: "No biometric device registered yet.", not_registered: true }, 400);
    }

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: "required",
      allowCredentials: creds.map((c) => ({ id: c.credential_id })),
    });

    await supabaseAdmin.from("webauthn_challenges").delete().lt("expires_at", new Date().toISOString());
    await supabaseAdmin.from("webauthn_challenges").insert({
      user_id: user.id,
      challenge: options.challenge,
      type: "authentication",
    });

    return json(options);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
