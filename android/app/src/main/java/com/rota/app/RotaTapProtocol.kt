package com.rota.app

import android.nfc.Tag
import android.nfc.tech.IsoDep
import android.util.Log
import java.nio.charset.Charset

// The APDU exchange for reading a Rota-emulated NFC tag — used by
// RotaNfcReaderPlugin while actively sending (TapSendSheet reads the other
// phone's passively-broadcast receive identity). Mirrors exactly what
// capacitor-hce-plugin's patched KHostApduService responds to on the other
// end: SELECT AID, then one custom read command that returns the content
// directly — no NFC-Forum CC/NDEF-file dance, since both ends of this
// private-AID exchange are Rota's own code and don't need to interop with
// anything else. Two round trips instead of the original six is most of
// what made a tap noticeably faster.
object RotaTapProtocol {
    private val AID = byteArrayOf(0xF0.toByte(), 0x52, 0x4F, 0x54, 0x41)
    private val APDU_SELECT =
        byteArrayOf(0x00, 0xA4.toByte(), 0x04, 0x00, 0x05) + AID + byteArrayOf(0x00)
    private val FAST_READ = byteArrayOf(0x00, 0xCA.toByte(), 0x00, 0x00, 0x00)

    // Returns the claim URL read from the tag, or null if it wasn't a valid
    // Rota tap (wrong AID, empty/default content, or the tag went out of
    // range mid-read).
    fun readUrl(tag: Tag): String? {
        val isoDep = IsoDep.get(tag)
        if (isoDep == null) {
            Log.w("RotaTapProtocol", "tag is not IsoDep-capable, techList=${tag.techList.joinToString()}")
            return null
        }
        try {
            isoDep.connect()
            isoDep.timeout = 3000

            if (!isOk(isoDep.transceive(APDU_SELECT))) {
                Log.w("RotaTapProtocol", "AID select failed — not a Rota tap (wrong/no AID match)")
                return null
            }

            val resp = isoDep.transceive(FAST_READ)
            if (!isOk(resp) || resp.size <= 2) return null
            val result = String(resp, 0, resp.size - 2, Charset.forName("UTF-8"))
            Log.i("RotaTapProtocol", "read succeeded, len=${result.length}")
            return result
        } catch (e: Exception) {
            Log.e("RotaTapProtocol", "tap read failed", e)
            return null
        } finally {
            try {
                isoDep.close()
            } catch (e: Exception) {
                // already closed
            }
        }
    }

    private fun isOk(resp: ByteArray?): Boolean {
        if (resp == null || resp.size < 2) return false
        return resp[resp.size - 2] == 0x90.toByte() && resp[resp.size - 1] == 0x00.toByte()
    }
}
