import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://szwlaxrsqqqlptmddgjs.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_m_xPu1lGKTTI8-kdrDkWcg_TuKAZlRF";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
