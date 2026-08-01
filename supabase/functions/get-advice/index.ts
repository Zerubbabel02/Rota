import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = "https://szwlaxrsqqqlptmddgjs.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_m_xPu1lGKTTI8-kdrDkWcg_TuKAZlRF";

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

function naira(n: number) {
  return "₦" + Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 0 });
}

function summarize(payments: any[], todos: any[]) {
  const paid = payments.filter((p) => p.status === "paid");
  const upcoming = payments
    .filter((p) => p.status === "upcoming")
    .sort((a, b) => a.date.localeCompare(b.date));
  const totalBudgeted = payments.reduce((s, p) => s + Number(p.amount), 0);
  const totalPaid = paid.reduce((s, p) => s + Number(p.amount), 0);
  const pendingTodos = todos.filter((t) => !t.done).length;
  return [
    `Total scheduled this month: ${naira(totalBudgeted)}. Already paid: ${naira(totalPaid)}.`,
    "Upcoming: " +
      (upcoming.length ? upcoming.map((p) => `${p.name} ${naira(p.amount)} on ${p.date}`).join("; ") : "none"),
    `Pending to-do items: ${pendingTodos}`,
  ].join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "Missing authorization" }, 401);

    const { question } = await req.json();
    if (!question || !String(question).trim()) return json({ error: "Missing question" }, 400);

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicKey) {
      return json({ error: "Server is not configured with an Anthropic API key yet." }, 500);
    }

    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: userErr,
    } = await supabaseClient.auth.getUser();
    if (userErr || !user) return json({ error: "Unauthorized" }, 401);

    const [{ data: paymentRows }, { data: todoRows }] = await Promise.all([
      supabaseClient.from("payments").select("*"),
      supabaseClient.from("todos").select("*"),
    ]);

    const context = summarize(paymentRows ?? [], todoRows ?? []);

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: `You are a friendly, plain-spoken budgeting helper inside a Nigerian scheduled-payments app called Rota. Give general, educational money-management suggestions only — never formal, personalized financial advice, and don't claim certainty about outcomes. Keep it under 150 words, practical, and specific to what's shared. Use ₦ for amounts.\n\nCurrent schedule:\n${context}\n\nQuestion: ${question}`,
          },
        ],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return json({ error: "Guidance service error", detail: errText }, 502);
    }
    const aiData = await aiRes.json();
    const text = (aiData.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    return json({ reply: text || "Couldn't generate guidance just now." });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
