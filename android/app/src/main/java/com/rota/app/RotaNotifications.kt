package com.rota.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Build
import androidx.core.app.NotificationCompat

// Every notification Rota Tap shows natively (not through the WebView) —
// the quick-accept banner with its own Accept/Decline buttons, and the
// plain result confirmations for auto-accept and post-claim outcomes.
object RotaNotifications {
    const val CHANNEL_ID = "rota_tap"
    const val ACTION_ACCEPT = "com.rota.app.TAP_ACCEPT"
    const val ACTION_DECLINE = "com.rota.app.TAP_DECLINE"
    const val EXTRA_TOKEN = "token"
    const val EXTRA_NOTIFICATION_ID = "notification_id"

    // How long the quick-accept banner stays actionable before it silently
    // clears itself — matches how long the offer stays worth showing for.
    const val QUICK_ACCEPT_TIMEOUT_MS = 60_000L

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Rota Tap",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Incoming Rota Tap transfers"
            enableVibration(true)
        }
        manager.createNotificationChannel(channel)
    }

    private fun baseBuilder(context: Context): NotificationCompat.Builder {
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_rota)
            .setColor(0xFF0B1120.toInt())
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
        try {
            val largeIcon = BitmapFactory.decodeResource(context.resources, R.drawable.ic_rota_large)
            if (largeIcon != null) builder.setLargeIcon(largeIcon)
        } catch (e: Exception) {
            // large icon is a nice-to-have, never worth failing the notification over
        }
        return builder
    }

    fun showQuickAccept(context: Context, notificationId: Int, token: String, senderName: String, amount: String) {
        ensureChannel(context)

        val acceptIntent = Intent(context, RotaTapActionReceiver::class.java).apply {
            action = ACTION_ACCEPT
            putExtra(EXTRA_TOKEN, token)
            putExtra(EXTRA_NOTIFICATION_ID, notificationId)
        }
        val acceptPending = PendingIntent.getBroadcast(
            context, notificationId * 2, acceptIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val declineIntent = Intent(context, RotaTapActionReceiver::class.java).apply {
            action = ACTION_DECLINE
            putExtra(EXTRA_TOKEN, token)
            putExtra(EXTRA_NOTIFICATION_ID, notificationId)
        }
        val declinePending = PendingIntent.getBroadcast(
            context, notificationId * 2 + 1, declineIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = baseBuilder(context)
            .setContentTitle("$amount incoming")
            .setContentText("From $senderName — tap Accept to receive it")
            .setStyle(NotificationCompat.BigTextStyle().bigText("$senderName is sending you $amount via Rota Tap. Accept to receive it in your wallet."))
            .setTimeoutAfter(QUICK_ACCEPT_TIMEOUT_MS)
            .addAction(0, "Accept", acceptPending)
            .addAction(0, "Decline", declinePending)
            .build()

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(notificationId, notification)
    }

    fun showResult(context: Context, notificationId: Int, title: String, body: String) {
        ensureChannel(context)
        val notification = baseBuilder(context)
            .setContentTitle(title)
            .setContentText(body)
            .build()
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(notificationId, notification)
    }

    fun cancel(context: Context, notificationId: Int) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.cancel(notificationId)
    }
}
