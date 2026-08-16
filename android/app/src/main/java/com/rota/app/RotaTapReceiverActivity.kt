package com.rota.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.os.Build
import android.os.Bundle
import android.util.Log
import kotlin.random.Random

// Registered in the manifest for android.nfc.action.TECH_DISCOVERED
// (IsoDep) — this is what lets a tap reach Rota even when the app isn't
// open at all, since that dispatch works from a cold/backgrounded state,
// unlike RotaNfcReaderPlugin's enableReaderMode() which only works in the
// foreground. Fully invisible: no layout is ever set, it reads the tag,
// acts according to the user's tap_receive_mode preference, and finishes
// itself immediately.
class RotaTapReceiverActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val tag: Tag? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent?.getParcelableExtra(NfcAdapter.EXTRA_TAG, Tag::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent?.getParcelableExtra(NfcAdapter.EXTRA_TAG)
        }

        if (tag == null) {
            finish()
            return
        }

        Thread {
            try {
                val url = RotaTapProtocol.readUrl(tag)
                val token = url?.let { Uri.parse(it).getQueryParameter("tap") }
                if (token != null) {
                    handleClaim(token)
                }
            } catch (e: Exception) {
                Log.e("RotaTapReceiver", "background tap failed", e)
            }
        }.start()

        // No UI was ever shown, so there's nothing to keep this Activity
        // around for — the background thread above outlives it fine since
        // it holds its own application Context, not this Activity.
        finish()
    }

    private fun handleClaim(token: String) {
        val notificationId = Random.nextInt(1, Int.MAX_VALUE)
        when (RotaSecureStore.getTapReceiveMode(applicationContext)) {
            "open_app" -> openApp(token)
            "auto_accept" -> autoAccept(token, notificationId)
            else -> quickAccept(token, notificationId)
        }
    }

    private fun openApp(token: String) {
        val launchIntent = Intent(applicationContext, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = Uri.parse("https://rota-app-zerubbabel1.vercel.app/?tap=$token")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        applicationContext.startActivity(launchIntent)
    }

    private fun quickAccept(token: String, notificationId: Int) {
        val preview = RotaApiClient.preview(token)
        if (!preview.ok) return // expired/invalid/already claimed — nothing worth notifying about
        val amount = formatNaira(preview.amount)
        RotaNotifications.showQuickAccept(applicationContext, notificationId, token, preview.senderName, amount)
    }

    private fun autoAccept(token: String, notificationId: Int) {
        val result = RotaApiClient.claim(applicationContext, token)
        if (result.ok) {
            RotaNotifications.showResult(
                applicationContext,
                notificationId,
                "Money received",
                "You received ${formatNaira(result.amount)} via Rota Tap from ${result.senderName}."
            )
        }
        // A failed silent auto-accept (expired, already claimed, offline)
        // deliberately shows nothing — there was never a receiver-facing
        // prompt for this mode, so a background failure shouldn't surface
        // one either.
    }

    companion object {
        fun formatNaira(amount: Double): String {
            val whole = amount.toLong()
            val s = whole.toString()
            val sb = StringBuilder()
            for ((i, c) in s.reversed().withIndex()) {
                if (i > 0 && i % 3 == 0) sb.append(',')
                sb.append(c)
            }
            return "₦" + sb.reverse().toString()
        }
    }
}
