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

    const { reference } = await req.json();
    if (!reference) return json({ error: "Missing reference" }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const paystackSecretKey = Deno.env.get("PAYSTACK_SECRET_KEY");

    if (!paystackSecretKey) {
      return json({ error: "Server is not configured with a Paystack secret key yet." }, 500);
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
    const user = userData.user;

    const paystackRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${paystackSecretKey}` } }
    );
    const paystackData = await paystackRes.json();

    if (!paystackRes.ok || !paystackData.status || paystackData.data?.status !== "success") {
      return json({ error: "Payment verification failed" }, 400);
    }

    const auth = paystackData.data.authorization;
    if (!auth?.authorization_code || !auth?.reusable) {
      return json({ error: "This card can't be saved for future scheduled payments." }, 400);
    }

    const last4 = auth.last4 ?? null;
    const customerCode = paystackData.data.customer?.customer_code ?? null;

    const { error: upsertErr } = await supabaseAdmin.from("payment_methods").upsert({
      user_id: user.id,
      paystack_customer_code: customerCode,
      paystack_authorization_code: auth.authorization_code,
      last4,
      card_type: auth.card_type ?? null,
    });
    if (upsertErr) return json({ error: "Could not save payment method" }, 500);

    const { error: profileErr } = await supabaseAdmin
      .from("profiles")
      .update({ card_linked: true, card_last4: last4 })
      .eq("id", user.id);
    if (profileErr) return json({ error: "Could not update profile" }, 500);

    return json({ success: true, last4 });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
