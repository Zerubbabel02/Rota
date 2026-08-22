package com.rota.app

import android.app.Activity
import android.nfc.NfcAdapter
import android.nfc.Tag
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.atomic.AtomicBoolean

// Used only while actively sending: TapSendSheet reads the other phone's
// passively-broadcast receive identity via enableReaderMode() (reliable —
// unlike the OS's background tag dispatch, which this used to depend on for
// receiving too, before that path proved unreliable across devices). Also
// exposes storeSession/clearSession so the JS layer can keep native code
// supplied with a fresh auth token for RotaTapActionReceiver's background
// Accept/Decline claims.
@CapacitorPlugin(name = "RotaNfcReader")
class RotaNfcReaderPlugin : Plugin() {
    private var nfcAdapter: NfcAdapter? = null
    private var wantsListening = false
    // Held phones get redetected several times a second by the reader-mode
    // poll loop — without this guard each redetection raced its own
    // readUrl() against the same IsoDep channel (see RotaTapReceiverActivity
    // for the same fix on the background path).
    private val isReading = AtomicBoolean(false)

    override fun load() {
        nfcAdapter = NfcAdapter.getDefaultAdapter(activity)
    }

    @PluginMethod
    fun startListening(call: PluginCall) {
        wantsListening = true
        enableReader()
        call.resolve()
    }

    @PluginMethod
    fun stopListening(call: PluginCall) {
        wantsListening = false
        disableReader()
        call.resolve()
    }

    @PluginMethod
    fun storeSession(call: PluginCall) {
        val accessToken = call.getString("accessToken")
        val refreshToken = call.getString("refreshToken")
        val userId = call.getString("userId")
        if (accessToken != null && refreshToken != null && userId != null) {
            RotaSecureStore.saveSession(context, accessToken, refreshToken, userId)
        }
        call.resolve()
    }

    @PluginMethod
    fun clearSession(call: PluginCall) {
        RotaSecureStore.clearSession(context)
        call.resolve()
    }

    // Open-app mode's notification launches MainActivity directly rather
    // than relying on Capacitor's deep-link (appUrlOpen) handling, which is
    // built around an already-running app receiving a *new* intent — a cold
    // start goes through onCreate() instead, a path that wasn't reliably
    // delivering the intent's data. Called once on app mount alongside the
    // appUrlOpen listener, so a claim triggered this way is picked up
    // regardless of whether the app was already running.
    @PluginMethod
    fun getPendingClaim(call: PluginCall) {
        val token = RotaNotifications.takePendingClaimToken(context)
        android.util.Log.i("RotaNfcReaderPlugin", "getPendingClaim: token=$token")
        val ret = JSObject()
        ret.put("token", token)
        call.resolve(ret)
    }

    override fun handleOnResume() {
        super.handleOnResume()
        if (wantsListening) enableReader()
    }

    override fun handleOnPause() {
        super.handleOnPause()
        disableReader()
    }

    private fun enableReader() {
        val act: Activity = activity ?: return
        act.runOnUiThread {
            nfcAdapter?.enableReaderMode(
                act,
                { tag -> onTag(tag) },
                NfcAdapter.FLAG_READER_NFC_A or
                    NfcAdapter.FLAG_READER_NFC_B or
                    NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK or
                    NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS,
                null
            )
        }
    }

    private fun disableReader() {
        val act = activity ?: return
        act.runOnUiThread {
            try {
                nfcAdapter?.disableReaderMode(act)
            } catch (e: Exception) {
                // activity may already be tearing down
            }
        }
    }

    private fun onTag(tag: Tag) {
        if (!isReading.compareAndSet(false, true)) return
        try {
            val url = RotaTapProtocol.readUrl(tag) ?: return
            activity?.runOnUiThread {
                val ret = JSObject()
                ret.put("url", url)
                notifyListeners("tapReceived", ret)
            }
        } finally {
            isReading.set(false)
        }
    }
}
