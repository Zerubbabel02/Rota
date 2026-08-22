package com.rota.app

import android.util.Log
import com.capacitorjs.plugins.pushnotifications.MessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlin.random.Random

// Extends (rather than replaces) Capacitor's own MessagingService so the
// existing JS-facing push handling keeps working untouched for every other
// message — this only intercepts the one custom type Rota Tap needs shown
// with real Accept/Decline buttons instead of a generic system notification.
// A data-only FCM message (see send-push's dataOnly flag) always reaches
// onMessageReceived() natively, regardless of whether the app is open,
// backgrounded, or fully closed — unlike a display "notification" payload,
// which Android would otherwise auto-render with no custom UI.
class RotaMessagingService : MessagingService() {
    companion object {
        private const val TAG = "RotaMessagingService"
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        val data = remoteMessage.data
        Log.i(TAG, "onMessageReceived: data=$data")
        val token = data["token"]
        val amount = data["amount"]?.toDoubleOrNull()
        val senderName = data["senderName"] ?: "A Rota user"

        if (data["type"] == "tap_quick_accept") {
            if (token != null && amount != null) {
                try {
                    RotaNotifications.showQuickAccept(
                        applicationContext,
                        Random.nextInt(1, Int.MAX_VALUE),
                        token,
                        senderName,
                        RotaNotifications.formatNaira(amount)
                    )
                    Log.i(TAG, "showQuickAccept: posted")
                } catch (e: Exception) {
                    Log.e(TAG, "showQuickAccept threw", e)
                }
            } else {
                Log.w(TAG, "tap_quick_accept: missing token or amount, token=$token amount=${data["amount"]}")
            }
            return
        }

        if (data["type"] == "tap_open_app") {
            if (token != null && amount != null) {
                try {
                    RotaNotifications.showOpenApp(
                        applicationContext,
                        Random.nextInt(1, Int.MAX_VALUE),
                        token,
                        senderName,
                        RotaNotifications.formatNaira(amount)
                    )
                    Log.i(TAG, "showOpenApp: posted")
                } catch (e: Exception) {
                    Log.e(TAG, "showOpenApp threw", e)
                }
            } else {
                Log.w(TAG, "tap_open_app: missing token or amount, token=$token amount=${data["amount"]}")
            }
            // Also relay to JS: if the app happens to already be open, this
            // is what jumps straight to the Accept screen without waiting
            // on the full-screen intent, which Android suppresses while
            // another app is actively in use.
            super.onMessageReceived(remoteMessage)
            return
        }

        super.onMessageReceived(remoteMessage)
    }
}
