package com.rota.app

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

// Session tokens live here, encrypted at rest, so RotaTapReceiverActivity
// and RotaTapActionReceiver (both can run without the JS layer / WebView
// alive at all) have something to authenticate a background claim with.
// The JS layer keeps this in sync via RotaNfcReaderPlugin.storeSession(),
// called on every Supabase auth state change.
object RotaSecureStore {
    private const val FILE_NAME = "rota_secure_prefs"
    private const val KEY_ACCESS_TOKEN = "access_token"
    private const val KEY_REFRESH_TOKEN = "refresh_token"
    private const val KEY_USER_ID = "user_id"
    private const val KEY_TAP_RECEIVE_MODE = "tap_receive_mode"

    private fun prefs(context: Context): SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            context,
            FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    fun saveSession(context: Context, accessToken: String, refreshToken: String, userId: String) {
        prefs(context).edit()
            .putString(KEY_ACCESS_TOKEN, accessToken)
            .putString(KEY_REFRESH_TOKEN, refreshToken)
            .putString(KEY_USER_ID, userId)
            .apply()
    }

    fun clearSession(context: Context) {
        prefs(context).edit()
            .remove(KEY_ACCESS_TOKEN)
            .remove(KEY_REFRESH_TOKEN)
            .remove(KEY_USER_ID)
            .apply()
    }

    fun getAccessToken(context: Context): String? = prefs(context).getString(KEY_ACCESS_TOKEN, null)
    fun getRefreshToken(context: Context): String? = prefs(context).getString(KEY_REFRESH_TOKEN, null)
    fun getUserId(context: Context): String? = prefs(context).getString(KEY_USER_ID, null)

    fun updateAccessToken(context: Context, accessToken: String, refreshToken: String) {
        prefs(context).edit()
            .putString(KEY_ACCESS_TOKEN, accessToken)
            .putString(KEY_REFRESH_TOKEN, refreshToken)
            .apply()
    }

    // Not encryption-sensitive (just a UI preference), but sharing the same
    // encrypted file keeps every piece of native-readable app state in one
    // place rather than two separate SharedPreferences files.
    fun saveTapReceiveMode(context: Context, mode: String) {
        prefs(context).edit().putString(KEY_TAP_RECEIVE_MODE, mode).apply()
    }

    fun getTapReceiveMode(context: Context): String =
        prefs(context).getString(KEY_TAP_RECEIVE_MODE, "quick_accept") ?: "quick_accept"
}
