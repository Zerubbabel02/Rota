import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
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
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) return json({ error: "Missing authorization" }, 401);

    const { pin } = await req.json();
    if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
      return json({ error: "PIN must be 4 digits." }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;

    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("has_pin, pin_hash, pin_salt, pin_failed_attempts, pin_locked_until")
      .eq("id", userId)
      .single();
    if (profileErr) return json({ error: "Could not load profile" }, 500);

    if (!profile.has_pin) return json({ error: "No PIN has been set yet.", needs_setup: true }, 400);

    if (profile.pin_locked_until && new Date(profile.pin_locked_until) > new Date()) {
      const minsLeft = Math.ceil((new Date(profile.pin_locked_until).getTime() - Date.now()) / 60000);
      return json({ error: `Too many attempts. Try again in ${minsLeft} minute${minsLeft === 1 ? "" : "s"}.`, locked: true }, 423);
    }

    const saltBytes = Uint8Array.from(atob(profile.pin_salt), (c) => c.charCodeAt(0));
    const candidateHash = await hashPin(pin, saltBytes);

    if (candidateHash === profile.pin_hash) {
      await supabaseAdmin
        .from("profiles")
        .update({ pin_failed_attempts: 0, pin_locked_until: null })
        .eq("id", userId);
      return json({ success: true });
    }

    const attempts = (profile.pin_failed_attempts || 0) + 1;
    const update: Record<string, unknown> = { pin_failed_attempts: attempts };
    if (attempts >= MAX_ATTEMPTS) {
      update.pin_locked_until = new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString();
      update.pin_failed_attempts = 0;
    }
    await supabaseAdmin.from("profiles").update(update).eq("id", userId);

    const remaining = Math.max(0, MAX_ATTEMPTS - attempts);
    return json(
      {
        error: attempts >= MAX_ATTEMPTS ? `Too many attempts. Locked for ${LOCKOUT_MINUTES} minutes.` : "Incorrect PIN.",
        attempts_remaining: remaining,
      },
      401
    );
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
