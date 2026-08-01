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

function toBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

async function hashPin(pin: string, salt: Uint8Array): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return toBase64(new Uint8Array(bits));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) return json({ error: "Missing authorization" }, 401);

    const { pin, current_pin } = await req.json();
    if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
      return json({ error: "PIN must be exactly 4 digits." }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;

    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("has_pin, pin_hash, pin_salt")
      .eq("id", userId)
      .single();
    if (profileErr) return json({ error: "Could not load profile" }, 500);

    // Changing an existing PIN requires the current one — setting one for
    // the first time doesn't, since there's nothing to prove yet.
    if (profile.has_pin) {
      if (typeof current_pin !== "string" || !/^\d{4}$/.test(current_pin)) {
        return json({ error: "Current PIN is required to change it." }, 400);
      }
      const saltBytes = Uint8Array.from(atob(profile.pin_salt), (c) => c.charCodeAt(0));
      const currentHash = await hashPin(current_pin, saltBytes);
      if (currentHash !== profile.pin_hash) {
        return json({ error: "Current PIN is incorrect." }, 401);
      }
    }

    const newSalt = crypto.getRandomValues(new Uint8Array(16));
    const newHash = await hashPin(pin, newSalt);

    const { error: updateErr } = await supabaseAdmin
      .from("profiles")
      .update({
        pin_hash: newHash,
        pin_salt: toBase64(newSalt),
        has_pin: true,
        pin_failed_attempts: 0,
        pin_locked_until: null,
      })
      .eq("id", userId);
    if (updateErr) return json({ error: updateErr.message }, 500);

    return json({ success: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
