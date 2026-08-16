package com.rota.app

import android.app.Activity
import android.nfc.NfcAdapter
import android.nfc.Tag
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

// The "listen for a tap while the app is open" half of Rota Tap's NFC
// transfer — pairs with RotaTapReceiverActivity, which handles the same
// protocol (RotaTapProtocol) when the app is backgrounded/closed instead.
// Also exposes storeSession/clearSession so the JS layer can keep native
// code supplied with a fresh auth token for background quick-accept/
// auto-accept claims.
@CapacitorPlugin(name = "RotaNfcReader")
class RotaNfcReaderPlugin : Plugin() {
    private var nfcAdapter: NfcAdapter? = null
    private var wantsListening = false

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

    @PluginMethod
    fun setTapReceiveMode(call: PluginCall) {
        val mode = call.getString("mode") ?: "quick_accept"
        RotaSecureStore.saveTapReceiveMode(context, mode)
        call.resolve()
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
        val url = RotaTapProtocol.readUrl(tag) ?: return
        activity?.runOnUiThread {
            val ret = JSObject()
            ret.put("url", url)
            notifyListeners("tapReceived", ret)
        }
    }
}
