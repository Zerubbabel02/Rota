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

// Supabase Auth has no built-in phone+password sign-in without SMS
// configured, so this resolves the phone number to its account's email
// server-side, then verifies the password through Supabase's own
// signInWithPassword — the real password check, just proxied through a
// phone-number lookup instead of the client already knowing the email.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const { phone, password } = await req.json();
    if (!phone || !password) return json({ error: "Enter your phone number and password." }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("phone", phone)
      .eq("phone_verified", true)
      .maybeSingle();
    // Same generic error whether the phone wasn't found or the password was
    // wrong — never confirm which, so a phone number can't be enumerated.
    if (!profile) return json({ error: "Couldn't sign in with that phone number and password." }, 401);

    const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.getUserById(profile.id);
    if (userErr || !userData?.user?.email) return json({ error: "Couldn't sign in with that phone number and password." }, 401);

    const { data: signInData, error: signInErr } = await supabaseAdmin.auth.signInWithPassword({
      email: userData.user.email,
      password,
    });
    if (signInErr || !signInData?.session) return json({ error: "Couldn't sign in with that phone number and password." }, 401);

    return json({
      ok: true,
      session: {
        access_token: signInData.session.access_token,
        refresh_token: signInData.session.refresh_token,
      },
    });
  } catch (_e) {
    return json({ error: "Unexpected server error" }, 500);
  }
});
