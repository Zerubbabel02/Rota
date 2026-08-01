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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) return json({ error: "Missing authorization" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const paystackSecretKey = Deno.env.get("PAYSTACK_SECRET_KEY");
    if (!paystackSecretKey) {
      return json({ error: "Server is not configured with a Paystack secret key yet." }, 500);
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

    const paystackRes = await fetch("https://api.paystack.co/bank?currency=NGN&country=nigeria", {
      headers: { Authorization: `Bearer ${paystackSecretKey}` },
    });
    const paystackData = await paystackRes.json();
    if (!paystackRes.ok || !paystackData.status) {
      return json({ error: "Could not load bank list" }, 502);
    }

    const banks = (paystackData.data || [])
      .filter((b: any) => b.active && b.code)
      .map((b: any) => ({ name: b.name, code: b.code }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name));

    return json({ banks });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
