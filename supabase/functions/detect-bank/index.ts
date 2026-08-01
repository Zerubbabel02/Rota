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

// Name fragments for the most common Nigerian banks and fintechs — matched
// against the live bank list rather than hardcoding bank codes, since codes
// can vary/change and we'd rather miss a rare bank than use a wrong code.
const PRIORITY_KEYWORDS = [
  "opay",
  "palmpay",
  "moniepoint",
  "kuda",
  "access bank",
  "guaranty trust",
  "gtbank",
  "zenith",
  "united bank for africa",
  "first bank",
  "fidelity",
  "union bank",
  "sterling",
  "stanbic",
  "ecobank",
  "fcmb",
  "wema",
  "polaris",
  "keystone",
  "unity bank",
  "providus",
  "jaiz",
  "heritage",
  "globus",
  "carbon",
  "paga",
  "vfd",
  "sparkle",
  "titan",
  "premiumtrust",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) return json({ error: "Missing authorization" }, 401);

    const { account_number } = await req.json();
    if (!account_number || account_number.length !== 10) {
      return json({ error: "A 10-digit account number is required" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const paystackSecretKey = Deno.env.get("PAYSTACK_SECRET_KEY");
    if (!paystackSecretKey) {
      return json({ error: "Server is not configured with a Paystack secret key yet." }, 500);
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

    const banksRes = await fetch("https://api.paystack.co/bank?currency=NGN&country=nigeria", {
      headers: { Authorization: `Bearer ${paystackSecretKey}` },
    });
    const banksData = await banksRes.json();
    if (!banksRes.ok || !banksData.status) {
      return json({ error: "Could not load bank list" }, 502);
    }

    const allBanks: { name: string; code: string }[] = (banksData.data || [])
      .filter((b: any) => b.active && b.code)
      .map((b: any) => ({ name: b.name, code: b.code }));

    const candidates = allBanks.filter((b) =>
      PRIORITY_KEYWORDS.some((kw) => b.name.toLowerCase().includes(kw))
    );

    const attempts = await Promise.allSettled(
      candidates.map(async (bank) => {
        const res = await fetch(
          `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(account_number)}&bank_code=${encodeURIComponent(bank.code)}`,
          { headers: { Authorization: `Bearer ${paystackSecretKey}` } }
        );
        const data = await res.json();
        if (res.ok && data.status) {
          return { bank_name: bank.name, bank_code: bank.code, account_name: data.data.account_name };
        }
        throw new Error("no match");
      })
    );

    const matches = attempts
      .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
      .map((r) => r.value);

    return json({ matches });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
