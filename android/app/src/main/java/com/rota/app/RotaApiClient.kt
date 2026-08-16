package com.rota.app

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

// Talks to the same Supabase edge functions the web/React layer already
// uses (tap-transfer-preview, tap-transfer-claim) plus the auth token
// refresh endpoint — all via plain HttpURLConnection so a background tap
// (app closed, no WebView/JS running at all) can still complete a claim.
object RotaApiClient {
    private const val TAG = "RotaApiClient"
    private const val SUPABASE_URL = "https://szwlaxrsqqqlptmddgjs.supabase.co"
    private const val PUBLISHABLE_KEY = "sb_publishable_m_xPu1lGKTTI8-kdrDkWcg_TuKAZlRF"

    data class PreviewResult(val ok: Boolean, val amount: Double, val senderName: String, val error: String?)
    data class ClaimResult(val ok: Boolean, val amount: Double, val senderName: String, val error: String?)

    fun preview(token: String): PreviewResult {
        return try {
            val body = JSONObject().put("token", token)
            val resp = post("$SUPABASE_URL/functions/v1/tap-transfer-preview", body, null)
            PreviewResult(
                ok = resp.optBoolean("ok", false),
                amount = resp.optDouble("amount", 0.0),
                senderName = resp.optString("senderName", "A Rota user"),
                error = if (resp.has("error")) resp.optString("error") else null
            )
        } catch (e: Exception) {
            Log.e(TAG, "preview failed", e)
            PreviewResult(false, 0.0, "", "Couldn't reach Rota.")
        }
    }

    // Refreshes the access token first if the stored one looks like it may
    // have expired — a background tap can happen hours or days after the
    // app was last open, long past a normal session's short access-token
    // lifetime.
    fun claim(context: Context, token: String): ClaimResult {
        var accessToken = RotaSecureStore.getAccessToken(context)
        if (accessToken == null) {
            return ClaimResult(false, 0.0, "", "Not signed in.")
        }

        try {
            val body = JSONObject().put("token", token)
            var resp = post("$SUPABASE_URL/functions/v1/tap-transfer-claim", body, accessToken)

            // 401 from an expired access token — refresh once and retry.
            if (resp.optString("error") == "Not signed in" || resp.optBoolean("__unauthorized", false)) {
                if (refreshAccessToken(context)) {
                    accessToken = RotaSecureStore.getAccessToken(context)
                    resp = post("$SUPABASE_URL/functions/v1/tap-transfer-claim", body, accessToken)
                }
            }

            return ClaimResult(
                ok = resp.optBoolean("ok", false),
                amount = resp.optDouble("amount", 0.0),
                senderName = resp.optString("senderName", "A Rota user"),
                error = if (resp.has("error")) resp.optString("error") else null
            )
        } catch (e: Exception) {
            Log.e(TAG, "claim failed", e)
            return ClaimResult(false, 0.0, "", "Couldn't complete this transfer.")
        }
    }

    private fun refreshAccessToken(context: Context): Boolean {
        val refreshToken = RotaSecureStore.getRefreshToken(context) ?: return false
        return try {
            val url = URL("$SUPABASE_URL/auth/v1/token?grant_type=refresh_token")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("apikey", PUBLISHABLE_KEY)
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true
            conn.connectTimeout = 8000
            conn.readTimeout = 8000

            val body = JSONObject().put("refresh_token", refreshToken)
            OutputStreamWriter(conn.outputStream).use { it.write(body.toString()) }

            val ok = conn.responseCode in 200..299
            val stream = if (ok) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.readText() ?: ""
            conn.disconnect()

            if (!ok) {
                Log.e(TAG, "token refresh failed: $text")
                return false
            }

            val json = JSONObject(text)
            val newAccess = json.optString("access_token", "")
            val newRefresh = json.optString("refresh_token", "")
            if (newAccess.isEmpty() || newRefresh.isEmpty()) return false

            RotaSecureStore.updateAccessToken(context, newAccess, newRefresh)
            true
        } catch (e: Exception) {
            Log.e(TAG, "token refresh error", e)
            false
        }
    }

    private fun post(urlStr: String, body: JSONObject, bearerToken: String?): JSONObject {
        val url = URL(urlStr)
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.setRequestProperty("apikey", PUBLISHABLE_KEY)
        conn.setRequestProperty("Content-Type", "application/json")
        if (bearerToken != null) {
            conn.setRequestProperty("Authorization", "Bearer $bearerToken")
        }
        conn.doOutput = true
        conn.connectTimeout = 8000
        conn.readTimeout = 8000

        OutputStreamWriter(conn.outputStream).use { it.write(body.toString()) }

        val responseCode = conn.responseCode
        val ok = responseCode in 200..299
        val stream = if (ok) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader()?.readText() ?: "{}"
        conn.disconnect()

        val json = try {
            JSONObject(text)
        } catch (e: Exception) {
            JSONObject()
        }
        if (!ok && !json.has("error")) {
            json.put("__unauthorized", responseCode == 401)
        }
        return json
    }
}
