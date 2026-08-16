package com.rota.app

import android.nfc.Tag
import android.nfc.tech.IsoDep
import android.util.Log
import java.nio.charset.Charset

// The APDU exchange for reading a Rota-emulated NFC tag — shared by
// RotaNfcReaderPlugin (foreground, app-open taps) and RotaTapReceiverActivity
// (background/closed-app taps via manifest tech-discovery). Mirrors exactly
// what capacitor-hce-plugin's KHostApduService responds to on the other end.
object RotaTapProtocol {
    private val AID = byteArrayOf(0xF0.toByte(), 0x52, 0x4F, 0x54, 0x41)
    private val APDU_SELECT =
        byteArrayOf(0x00, 0xA4.toByte(), 0x04, 0x00, 0x05) + AID + byteArrayOf(0x00)
    private val CAPABILITY_CONTAINER_SELECT =
        byteArrayOf(0x00, 0xA4.toByte(), 0x00, 0x0C, 0x02, 0xE1.toByte(), 0x03)
    private val READ_CAPABILITY_CONTAINER = byteArrayOf(0x00, 0xB0.toByte(), 0x00, 0x00, 0x0F)
    private val NDEF_SELECT = byteArrayOf(0x00, 0xA4.toByte(), 0x00, 0x0C, 0x02, 0xE1.toByte(), 0x04)
    private val NDEF_READ_NLEN = byteArrayOf(0x00, 0xB0.toByte(), 0x00, 0x00, 0x02)
    private const val MAX_CHUNK = 200

    // Returns the claim URL read from the tag, or null if it wasn't a valid
    // Rota tap (wrong AID, malformed NDEF, or the tag went out of range
    // mid-read).
    fun readUrl(tag: Tag): String? {
        val isoDep = IsoDep.get(tag) ?: return null
        try {
            isoDep.connect()
            isoDep.timeout = 3000

            if (!isOk(isoDep.transceive(APDU_SELECT))) return null
            if (!isOk(isoDep.transceive(CAPABILITY_CONTAINER_SELECT))) return null
            if (!isOk(isoDep.transceive(READ_CAPABILITY_CONTAINER))) return null
            if (!isOk(isoDep.transceive(NDEF_SELECT))) return null

            val nlenResp = isoDep.transceive(NDEF_READ_NLEN)
            if (!isOk(nlenResp) || nlenResp.size < 4) return null
            val nlen = ((nlenResp[0].toInt() and 0xFF) shl 8) or (nlenResp[1].toInt() and 0xFF)
            if (nlen <= 0) return null

            val out = ByteArray(nlen)
            var readSoFar = 0
            while (readSoFar < nlen) {
                val chunkLen = minOf(MAX_CHUNK, nlen - readSoFar)
                val offset = 2 + readSoFar
                val cmd = byteArrayOf(
                    0x00, 0xB0.toByte(),
                    ((offset shr 8) and 0xFF).toByte(), (offset and 0xFF).toByte(),
                    chunkLen.toByte()
                )
                val resp = isoDep.transceive(cmd)
                if (!isOk(resp) || resp.size < 2) return null
                val dataLen = resp.size - 2
                System.arraycopy(resp, 0, out, readSoFar, dataLen)
                readSoFar += dataLen
            }

            return parseNdefUri(out)
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

    // Mirrors capacitor-hce-plugin's createUriRecord: TNF_ABSOLUTE_URI (3),
    // empty payload, URI text stored in the record's TYPE field.
    private fun parseNdefUri(ndef: ByteArray): String? {
        if (ndef.isEmpty()) return null
        var i = 0
        val flags = ndef[i].toInt() and 0xFF
        val tnf = flags and 0x07
        i += 1
        if (i >= ndef.size) return null
        val typeLen = ndef[i].toInt() and 0xFF
        i += 1

        val sr = (flags and 0x10) != 0
        val payloadLen: Int
        if (sr) {
            if (i >= ndef.size) return null
            payloadLen = ndef[i].toInt() and 0xFF
            i += 1
        } else {
            if (i + 4 > ndef.size) return null
            payloadLen = ((ndef[i].toInt() and 0xFF) shl 24) or
                ((ndef[i + 1].toInt() and 0xFF) shl 16) or
                ((ndef[i + 2].toInt() and 0xFF) shl 8) or
                (ndef[i + 3].toInt() and 0xFF)
            i += 4
        }

        val idLen = if ((flags and 0x08) != 0) {
            if (i >= ndef.size) return null
            val v = ndef[i].toInt() and 0xFF
            i += 1
            v
        } else 0

        if (i + typeLen > ndef.size) return null
        val type = ndef.sliceArray(i until i + typeLen)
        i += typeLen
        i += idLen

        return if (tnf == 0x03) {
            String(type, Charset.forName("UTF-8"))
        } else {
            null
        }
    }
}
