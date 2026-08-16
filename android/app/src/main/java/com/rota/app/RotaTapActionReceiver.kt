package com.rota.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// Handles the Accept/Decline buttons on the quick-accept notification —
// runs even if Rota isn't open, since a BroadcastReceiver doesn't need an
// Activity. goAsync() keeps the process alive long enough for the claim's
// network round trip; without it Android is free to kill things the
// instant onReceive() returns, which a blocking HTTP call would outlive.
class RotaTapActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val token = intent.getStringExtra(RotaNotifications.EXTRA_TOKEN) ?: return
        val notificationId = intent.getIntExtra(RotaNotifications.EXTRA_NOTIFICATION_ID, 0)

        if (intent.action == RotaNotifications.ACTION_DECLINE) {
            RotaNotifications.cancel(context, notificationId)
            return
        }

        if (intent.action != RotaNotifications.ACTION_ACCEPT) return

        val appContext = context.applicationContext
        val pendingResult = goAsync()
        Thread {
            try {
                val result = RotaApiClient.claim(appContext, token)
                if (result.ok) {
                    RotaNotifications.showResult(
                        appContext,
                        notificationId,
                        "Money received",
                        "You received ${RotaTapReceiverActivity.formatNaira(result.amount)} via Rota Tap from ${result.senderName}."
                    )
                } else {
                    RotaNotifications.showResult(
                        appContext,
                        notificationId,
                        "Couldn't accept",
                        result.error ?: "This transfer may have expired — check the app for details."
                    )
                }
            } finally {
                pendingResult.finish()
            }
        }.start()
    }
}
