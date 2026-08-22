package com.rota.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat

// Every notification Rota Tap shows natively (not through the WebView) —
// the quick-accept banner with its own Accept/Decline buttons, and the
// plain result confirmations for auto-accept and post-claim outcomes.
//
// The Accept/Decline banner went through two attempts at a fully custom
// RemoteViews layout (per-button colors, bigger Accept) before landing back
// here on standard notification actions — both attempts had manager.notify()
// succeed with nothing ever appearing on screen, confirmed live on-device
// twice. RemoteViews render in System UI's own process, so a failure there
// throws no exception and logs nothing on our side; there's no way to
// detect or recover from it. Standard actions can't have per-button colors
// or sizes either (both are hard Android platform limits — visible in any
// other app's own notifications, not something specific to this one), but
// they're the version that's actually proven to render reliably.
object RotaNotifications {
    // Renamed from the original "rota_tap" — once a channel is created,
    // Android locks its importance to whatever it currently is; the app
    // can never raise it back with code, only the user can from Settings.
    // A channel can get silently demoted into the "Silent" section by
    // Android's own adaptive behavior when notifications are repeatedly
    // dismissed without being tapped — exactly what months of test
    // notifications during development would look like to the system. A
    // fresh channel ID starts with a clean history and the real
    // IMPORTANCE_HIGH we ask for, which existing installs can't retroactively
    // get any other way.
    const val CHANNEL_ID = "rota_tap_v2"
    const val ACTION_ACCEPT = "com.rota.app.TAP_ACCEPT"
    const val ACTION_DECLINE = "com.rota.app.TAP_DECLINE"
    const val EXTRA_TOKEN = "token"
    const val EXTRA_NOTIFICATION_ID = "notification_id"

    // How long the quick-accept banner stays actionable before it silently
    // clears itself — matches how long the offer stays worth showing for.
    const val QUICK_ACCEPT_TIMEOUT_MS = 5 * 60_000L

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val existing = manager.getNotificationChannel(CHANNEL_ID)
        if (existing != null) {
            Log.i("RotaNotifications", "ensureChannel: channel exists, importance=${existing.importance}")
            return
        }
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

        // Tapping the body (as opposed to either action button) opens the
        // app to the same Accept screen, for anyone who wants the full
        // details before deciding rather than acting straight from the banner.
        val bodyLaunchIntent = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = Uri.parse("https://rota-app-zerubbabel1.vercel.app/?tap=$token")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val bodyLaunchPending = PendingIntent.getActivity(
            context, notificationId, bodyLaunchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // setFullScreenIntent is what actually made "open app" mode pop up
        // reliably (confirmed by a live side-by-side comparison — "open app"
        // used it and always dropped down; this banner didn't, and kept
        // landing in the Silent section despite a fresh, correctly
        // IMPORTANCE_HIGH channel). Full-screen intents get the OS's
        // strongest "this must not be missed" treatment, which is exactly
        // the un-ignorable behavior this banner needs. It doesn't force the
        // app open here the way "open app" mode does — Android only
        // auto-launches a full-screen intent's target when the device is
        // locked or the screen is off; with the screen already on and in
        // use it just uses this to guarantee the heads-up popup, same as
        // before. The target reuses bodyLaunchPending (opens to this same
        // Accept screen) so even a locked-screen auto-launch is the correct,
        // harmless outcome — never an auto-accept.
        val notification = baseBuilder(context)
            .setContentTitle("$amount incoming")
            .setContentText("From $senderName — tap Accept to receive it")
            .setStyle(NotificationCompat.BigTextStyle().bigText("$senderName is sending you $amount via Rota Tap. Accept to receive it in your wallet."))
            .setTimeoutAfter(QUICK_ACCEPT_TIMEOUT_MS)
            .setContentIntent(bodyLaunchPending)
            .setFullScreenIntent(bodyLaunchPending, true)
            .addAction(R.drawable.ic_action_accept, "Accept", acceptPending)
            .addAction(R.drawable.ic_action_decline, "Reject", declinePending)
            .build()

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val areEnabled = manager.areNotificationsEnabled()
        Log.i("RotaNotifications", "showQuickAccept: notify() called, id=$notificationId, notificationsEnabled=$areEnabled")
        manager.notify(notificationId, notification)
    }

    // Open app mode: launches straight to the Accept screen without the
    // receiver tapping anything first — the same full-screen-intent
    // mechanism an incoming call uses to surface itself automatically, even
    // over the lock screen. Android suppresses the auto-launch (falls back
    // to a normal tappable notification) if some other app is actively in
    // use at the moment, by design — it won't yank focus away mid-task.
    fun showOpenApp(context: Context, notificationId: Int, token: String, senderName: String, amount: String) {
        ensureChannel(context)
        stashPendingClaimToken(context, token)

        val launchIntent = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = Uri.parse("https://rota-app-zerubbabel1.vercel.app/?tap=$token")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val launchPending = PendingIntent.getActivity(
            context, notificationId, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = baseBuilder(context)
            .setContentTitle("$amount incoming")
            .setContentText("From $senderName — open Rota to receive it")
            .setContentIntent(launchPending)
            .setFullScreenIntent(launchPending, true)
            .build()

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        Log.i("RotaNotifications", "showOpenApp: notify() called, id=$notificationId, stashed token for claim=$token")
        manager.notify(notificationId, notification)
    }

    // These previously had no tap target at all — dismissed on tap
    // (setAutoCancel, from baseBuilder) but never actually opened the app,
    // which for a "you received ₦X" notification is the whole point of
    // tapping it.
    fun showResult(context: Context, notificationId: Int, title: String, body: String) {
        ensureChannel(context)
        val launchIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val launchPending = PendingIntent.getActivity(
            context, notificationId, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = baseBuilder(context)
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(launchPending)
            .build()
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(notificationId, notification)
    }

    fun cancel(context: Context, notificationId: Int) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.cancel(notificationId)
    }

    private const val PENDING_PREFS = "rota_pending"
    private const val KEY_PENDING_CLAIM_TOKEN = "pending_claim_token"

    // Belt-and-suspenders alongside the intent's own VIEW/data URI: a cold
    // start goes through onCreate() rather than the onNewIntent() path
    // Capacitor's appUrlOpen deep-link handling is built around, so this
    // stash is the channel RotaNfcReaderPlugin.getPendingClaim() reads on
    // every app mount to guarantee the token gets picked up either way. Not
    // encryption-sensitive — a claim token only identifies which pending
    // transfer to open, it doesn't move money by itself.
    private fun stashPendingClaimToken(context: Context, token: String) {
        context.getSharedPreferences(PENDING_PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY_PENDING_CLAIM_TOKEN, token).apply()
    }

    fun takePendingClaimToken(context: Context): String? {
        val prefs = context.getSharedPreferences(PENDING_PREFS, Context.MODE_PRIVATE)
        val token = prefs.getString(KEY_PENDING_CLAIM_TOKEN, null)
        if (token != null) prefs.edit().remove(KEY_PENDING_CLAIM_TOKEN).apply()
        return token
    }

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
