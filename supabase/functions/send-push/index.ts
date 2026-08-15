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

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64url(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// deno-lint-ignore no-explicit-any
async function getAccessToken(sa: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64url(signature)}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Token exchange failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    // Internal-only: callers must present the actual service role key, not
    // a regular user session — otherwise any signed-in user could spam a
    // push to any other user just by knowing their id. Compared directly
    // rather than by decoding a JWT "role" claim, since this project's
    // service role key is the newer opaque sb_secret_... format, not a JWT.
    const authHeader = req.headers.get("Authorization") ?? "";
    const presentedKey = authHeader.replace(/^Bearer\s+/i, "");
    if (!presentedKey || presentedKey !== Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
      return json({ error: "Forbidden — internal use only" }, 403);
    }

    const { userId, title, body, data } = await req.json();
    if (!userId || !title || !body) return json({ error: "Missing userId, title, or body" }, 400);

    const saJson = Deno.env.get("FCM_SERVICE_ACCOUNT_JSON");
    if (!saJson) return json({ error: "Push not configured" }, 500);
    const sa = JSON.parse(saJson);

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: tokens } = await supabaseAdmin
      .from("device_push_tokens")
      .select("token")
      .eq("user_id", userId);
    if (!tokens || tokens.length === 0) return json({ success: true, sent: 0 });

    const accessToken = await getAccessToken(sa);

    let sent = 0;
    await Promise.all(
      tokens.map(async ({ token }: { token: string }) => {
        const resp = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: {
              token,
              notification: { title, body },
              data: data || {},
              android: { notification: { icon: "ic_stat_rota", color: "#0B1120" } },
            },
          }),
        });
        if (resp.ok) {
          sent++;
        } else {
          const errText = await resp.text();
          if (resp.status === 404 || errText.includes("UNREGISTERED") || errText.includes("NOT_FOUND")) {
            await supabaseAdmin.from("device_push_tokens").delete().eq("token", token);
          }
        }
      })
    );

    return json({ success: true, sent });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
