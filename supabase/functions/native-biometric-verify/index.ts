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

async function hashSecret(secret: string, salt: Uint8Array): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) return json({ error: "Missing authorization" }, 401);

    const { secret } = await req.json();
    if (typeof secret !== "string" || !secret) return json({ error: "Missing secret." }, 400);

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("native_biometric_hash, native_biometric_salt")
      .eq("id", userData.user.id)
      .single();
    if (profileErr) return json({ error: "Could not load profile" }, 500);
    if (!profile.native_biometric_hash || !profile.native_biometric_salt) {
      return json({ error: "Native biometric isn't set up on this device.", needs_setup: true }, 400);
    }

    const saltBytes = Uint8Array.from(atob(profile.native_biometric_salt), (c) => c.charCodeAt(0));
    const candidateHash = await hashSecret(secret, saltBytes);

    if (candidateHash !== profile.native_biometric_hash) {
      return json({ error: "Couldn't verify — use your PIN instead." }, 401);
    }

    return json({ success: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
