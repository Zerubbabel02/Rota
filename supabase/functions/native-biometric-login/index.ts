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

// native-biometric-enroll/-verify both require an existing session — they
// only confirm an action mid-session, they can't establish a new one. This
// is the signed-out counterpart: the device already holds a Keystore-backed
// secret from a prior enrollment (see native-biometric-enroll), and proving
// it matches what's on file is enough to mint a real session, the same way
// a password would — via Supabase's own magic-link token issuance rather
// than any custom-minted token.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const { userId, secret } = await req.json();
    if (!userId || !secret) return json({ error: "Missing credentials." }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("native_biometric_hash, native_biometric_salt")
      .eq("id", userId)
      .maybeSingle();
    if (profileErr || !profile?.native_biometric_hash || !profile.native_biometric_salt) {
      return json({ error: "Biometric login isn't set up for this account on this device." }, 401);
    }

    const candidateHash = await hashSecret(secret, saltBytesFromB64(profile.native_biometric_salt));
    if (candidateHash !== profile.native_biometric_hash) {
      return json({ error: "Couldn't verify — use your password instead." }, 401);
    }

    const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (userErr || !userData?.user?.email) return json({ error: "Couldn't sign in — use your password instead." }, 401);

    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: userData.user.email,
    });
    if (linkErr || !linkData?.properties?.hashed_token) {
      return json({ error: "Couldn't sign in — use your password instead." }, 500);
    }

    return json({ ok: true, token_hash: linkData.properties.hashed_token });
  } catch (_e) {
    return json({ error: "Unexpected server error" }, 500);
  }
});
