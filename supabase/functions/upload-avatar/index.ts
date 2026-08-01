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

    const { image_base64, content_type } = await req.json();
    if (!image_base64 || !content_type) {
      return json({ error: "Missing image data" }, 400);
    }
    if (!content_type.startsWith("image/")) {
      return json({ error: "File must be an image" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
    const user = userData.user;

    const bytes = Uint8Array.from(atob(image_base64), (c) => c.charCodeAt(0));
    if (bytes.length > 5 * 1024 * 1024) {
      return json({ error: "Image must be under 5MB" }, 400);
    }

    const ext = content_type.split("/")[1]?.split("+")[0] || "jpg";
    const path = `${user.id}/avatar.${ext}`;

    const { error: uploadErr } = await supabaseAdmin.storage
      .from("avatars")
      .upload(path, bytes, { upsert: true, contentType: content_type, cacheControl: "3600" });
    if (uploadErr) return json({ error: uploadErr.message || "Upload failed" }, 500);

    const { data: publicUrlData } = supabaseAdmin.storage.from("avatars").getPublicUrl(path);
    const avatarUrl = `${publicUrlData.publicUrl}?t=${Date.now()}`;

    const { error: profileErr } = await supabaseAdmin
      .from("profiles")
      .update({ avatar_url: avatarUrl })
      .eq("id", user.id);
    if (profileErr) return json({ error: "Uploaded but could not save to profile" }, 500);

    return json({ success: true, avatarUrl });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
