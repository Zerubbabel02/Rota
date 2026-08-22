import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabaseClient.js";
import { startRegistration, startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { NativeBiometric } from "capacitor-native-biometric";
import { HCECapacitorPlugin } from "capacitor-hce-plugin";
import { App as CapacitorApp } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Share } from "@capacitor/share";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { PushNotifications } from "@capacitor/push-notifications";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Contacts } from "@capacitor-community/contacts";
import QRCode from "qrcode";
import jsQR from "jsqr";
import RotaMark from "./components/RotaMark.jsx";
import mtnLogo from "./assets/networks/mtn.svg";
import gloLogo from "./assets/networks/glo.svg";
import airtelLogo from "./assets/networks/airtel.svg";
import nineMobileLogo from "./assets/networks/9mobile.svg";
import {
  Home as HomeIcon,
  Calendar,
  CheckSquare,
  Sparkles,
  User,
  Plus,
  Clock,
  Wallet,
  ShieldCheck,
  Check,
  Trash2,
  Bell,
  Fingerprint,
  LogOut,
  X,
  CreditCard,
  Loader2,
  RotateCcw,
  Pencil,
  Share2,
  Receipt,
  ChevronDown,
  Search,
  Lock,
  Moon,
  ArrowDownLeft,
  ArrowUpRight,
  Landmark,
  Smartphone,
  QrCode,
  Copy,
  ArrowLeftRight,
  Wifi,
  Eye,
  EyeOff,
  Gift,
  Zap,
} from "lucide-react";

/* ---------- Design tokens ---------- */
const PALETTES = {
  light: {
    ink: "#FBF8F2", // milky off-white — main background
    ink2: "#FFFFFF", // card / elevated surface
    ink3: "#EDE4D3", // hairline borders, dividers, rail line, off states
    paper: "#2E2A22", // primary text (dark, on the light background)
    paperDim: "#A79E8C",
    gold: "#8B5CF6", // primary accent — vivid violet, the "pop" color
    goldSoft: "#FFC93C", // sunny yellow accent
    ok: "#1FC28B", // success / paid — bright teal-green
    warn: "#FF6B5B", // alerts — vivid coral
    blue: "#4C8EFF", // extra accent for variety
    muted: "#9C927F", // secondary text
  },
  dark: {
    ink: "#0B1120", // near-black navy — main background
    ink2: "#141B2E", // card / elevated surface
    ink3: "#232B42", // hairline borders, dividers, rail line, off states
    paper: "#F1F5F9", // primary text (near-white, on the dark background)
    paperDim: "#94A3B8",
    gold: "#A3E635", // primary accent — lime green, the "pop" color
    goldSoft: "#FDE047", // warm yellow accent
    ok: "#34D399", // success / paid
    warn: "#FB7185", // alerts
    blue: "#60A5FA", // extra accent for variety
    muted: "#7C8AA5", // secondary text
  },
};
// T is intentionally a mutable object rather than a fresh one per theme —
// every component reads T.xxx at render time via plain property access, so
// applyTheme() below can just overwrite its fields in place and the whole
// tree picks up the new colors on next render, without threading a theme
// value through every component's props.
let T = { ...PALETTES.light };
function applyTheme(isDark) {
  Object.assign(T, isDark ? PALETTES.dark : PALETTES.light);
}

// The wrapped Android app's WebView has no navigator.credentials, so
// WebAuthn (used on the website) can't work there. Native biometric confirm
// instead unlocks an opaque server-issued secret stored behind Android
// Keystore + BiometricPrompt (capacitor-native-biometric) — same
// hash-only-on-server model as the transaction PIN.
const NATIVE_BIO_SERVER = "rota-native-biometric";
const NATIVE_BIO_FLAG_KEY = "rota_native_bio_enrolled";
// Which account this device's enrolled Keystore secret belongs to, so the
// signed-out login screen can offer a biometric quick-login only when this
// specific device has actually enrolled someone before — a fresh install
// naturally has neither key set, which is what forces the real password.
const NATIVE_BIO_USER_KEY = "rota_native_bio_user_id";
const NATIVE_BIO_LABEL_KEY = "rota_native_bio_label";
const IS_NATIVE = Capacitor.isNativePlatform();
// Native-only local plugin (android/app/.../RotaNfcReaderPlugin.kt) — the
// "listen for a tap" half capacitor-hce-plugin doesn't provide.
const RotaNfcReader = registerPlugin("RotaNfcReader");

// Global stack of "close me" callbacks for whatever sheet/overlay is
// currently mounted, so the Android hardware/gesture back button can close
// the topmost one without every component needing to know about every
// other — each sheet pushes itself on mount and pops on unmount via
// useBackClose below; the top-level backButton listener (in RotaApp) just
// pops and calls the top of the stack, which naturally cascades correctly
// for sheets nested inside other sheets.
const rotaBackStack = [];
function useBackClose(onClose, active = true) {
  useEffect(() => {
    if (!active || !onClose) return;
    rotaBackStack.push(onClose);
    return () => {
      const idx = rotaBackStack.lastIndexOf(onClose);
      if (idx !== -1) rotaBackStack.splice(idx, 1);
    };
  }, [onClose, active]);
}

// Keeps native code (RotaTapActionReceiver, RotaMessagingService) supplied
// with a fresh session — those run without any JS/WebView alive at all, e.g.
// tapping Accept on a Rota Tap notification while the app is closed.
function syncNativeSession(session) {
  if (!IS_NATIVE || !session?.access_token || !session?.refresh_token || !session?.user?.id) return;
  RotaNfcReader.storeSession({
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    userId: session.user.id,
  }).catch(() => {});
}

// Passively broadcasts "this phone belongs to receiveToken" via HCE — the
// whole reason receiving a Rota Tap no longer needs this phone to do
// anything at all. Answers screen-off and app-closed exactly like sending
// already did (persistMessage/persistent together make the native side keep
// answering indefinitely instead of self-clearing after one tap, see
// KHostApduService.kt). Whoever taps this phone reads the token and calls
// tap-transfer-direct themselves.
function startReceiveBroadcast(token) {
  if (!IS_NATIVE || !token) return Promise.resolve();
  const url = `${window.location.origin}/?receive=${token}`;
  return HCECapacitorPlugin.isNfcHceSupported()
    .then(({ supported }) => {
      if (!supported) return;
      return HCECapacitorPlugin.startNfcHce({ content: url, mimeType: "RTD_URI", persistMessage: true, persistent: true });
    })
    .catch(() => {});
}

const FONT_DISPLAY = "'Fredoka', 'Baloo 2', system-ui, sans-serif";
const FONT_BODY = "'Nunito', system-ui, -apple-system, sans-serif";
const FONT_MONO = "'IBM Plex Mono', ui-monospace, Menlo, monospace";

const CATEGORIES = ["Housing", "Utilities", "Entertainment", "Savings", "Transport", "Other"];

// Approximate, prefix-based — number portability means this is a best guess,
// same as how OPay/PalmPay's own auto-detect works, not a certainty.
const NETWORK_PREFIXES = {
  MTN: ["0803", "0806", "0703", "0706", "0813", "0814", "0816", "0810", "0903", "0906", "0913", "0916"],
  Glo: ["0805", "0807", "0705", "0815", "0811", "0905", "0915"],
  Airtel: ["0802", "0808", "0708", "0812", "0701", "0902", "0901", "0904", "0912", "0907"],
  "9mobile": ["0809", "0817", "0818", "0908", "0909"],
};
function detectNetwork(phone) {
  const prefix = phone.slice(0, 4);
  for (const [network, prefixes] of Object.entries(NETWORK_PREFIXES)) {
    if (prefixes.includes(prefix)) return network;
  }
  return null;
}
const NETWORK_LOGOS = { MTN: mtnLogo, Glo: gloLogo, Airtel: airtelLogo, "9mobile": nineMobileLogo };
const DISCOS = [
  "Ikeja Electric",
  "Eko Electric",
  "Abuja Electric",
  "Kano Electric",
  "Port Harcourt Electric",
  "Jos Electric",
  "Kaduna Electric",
  "Benin Electric",
  "Enugu Electric",
  "Ibadan Electric",
  "Yola Electric",
];
const DATA_BUNDLES = [
  { label: "1GB — 30 days", value: "1gb" },
  { label: "2GB — 30 days", value: "2gb" },
  { label: "5GB — 30 days", value: "5gb" },
  { label: "10GB — 30 days", value: "10gb" },
];
const AIRTIME_PRESETS = [50, 100, 200, 500, 1000, 2000];
const DATA_TABS = ["Hot", "Daily", "Weekly", "Monthly"];
const DATA_PLANS_BY_TAB = {
  Hot: [
    { label: "1GB", sub: "1 Day", value: "hot-1gb-1d" },
    { label: "2.5GB", sub: "1 Day", value: "hot-2.5gb-1d" },
    { label: "500MB", sub: "7 Days", value: "hot-500mb-7d" },
  ],
  Daily: [
    { label: "1GB", sub: "1 Day", value: "daily-1gb" },
    { label: "2GB", sub: "1 Day", value: "daily-2gb" },
  ],
  Weekly: [
    { label: "1.5GB", sub: "7 Days", value: "weekly-1.5gb" },
    { label: "3.5GB", sub: "7 Days", value: "weekly-3.5gb" },
  ],
  Monthly: [
    { label: "2GB", sub: "30 Days", value: "monthly-2gb" },
    { label: "7GB", sub: "30 Days", value: "monthly-7gb" },
    { label: "10GB", sub: "30 Days", value: "monthly-10gb" },
  ],
};

const TAP_RECEIVE_MODE_LABELS = {
  quick_accept: "Notify",
  open_app: "Open app",
  auto_accept: "Automatic",
};
const PAYSTACK_PUBLIC_KEY = "pk_test_b8acc1eeb9f5b9140c1f20c56c426c16d3598add";
// A function rather than a frozen object — CATEGORY_COLOR used to capture T's
// hex values once at module load, so it never updated when the theme changed.
function categoryColor(category) {
  return (
    {
      Housing: T.gold,
      Utilities: T.ok,
      Entertainment: T.warn,
      Savings: T.goldSoft,
      Transport: T.blue,
      Other: T.muted,
    }[category] || T.muted
  );
}

/* ---------- Helpers ---------- */
function naira(n) {
  return "₦" + Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 0 });
}
function maskEmail(email) {
  if (!email) return "—";
  const [local, domain] = email.split("@");
  if (!domain) return email;
  return `${local[0] || ""}${"*".repeat(Math.max(local.length - 1, 1))}@${domain}`;
}
function maskDate(dateStr) {
  if (!dateStr) return "Add date of birth";
  return "•• ••, ••••";
}
function isoOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function dayNum(iso) {
  return new Date(iso + "T00:00:00").getDate();
}
function weekdayAbbr(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { weekday: "short" }).toUpperCase();
}
function daysAway(iso) {
  const today = new Date(todayISO() + "T00:00:00");
  const target = new Date(iso + "T00:00:00");
  const diff = Math.round((target - today) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff < 0) return `${Math.abs(diff)}d overdue`;
  return `In ${diff} days`;
}
function uid() {
  return Math.random().toString(36).slice(2, 10);
}
// Nigerian transfer pricing works the other way round from most fee models:
// the bank advertises a flat charge (₦10/₦25/₦50 by band) which is already
// VAT-inclusive, so the fee and the 7.5% VAT are back-derived from it rather
// than added on top. That's why the split lands on odd figures like 8.37 +
// 0.63 rather than a round number.
const VAT_RATE = 0.075;
function transferCharge(amount) {
  const a = Number(amount) || 0;
  const flat = a <= 5000 ? 10 : a <= 50000 ? 25 : 50;
  const fee = Math.round((flat / (1 + VAT_RATE)) * 100) / 100;
  const vat = Math.round((flat - fee) * 100) / 100;
  return { fee, vat, charge: flat, total: a + flat };
}
function nairaExact(n) {
  return (
    "₦" +
    Number(n || 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

// On mobile browsers the on-screen keyboard shrinks the visual viewport but
// leaves layout height untouched, so a bottom sheet ends up hidden behind the
// keyboard. visualViewport tells us how much is covered; sheets add that as
// bottom padding so the focused field stays visible.
function useKeyboardInset() {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const update = () => {
      const covered = window.innerHeight - vv.height - vv.offsetTop;
      setInset(covered > 80 ? covered : 0);
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

function defaultSettings() {
  return {
    name: "there",
    notifications: true,
    biometric: false,
    cardLinked: false,
    cardLast4: null,
    avatarUrl: null,
    hasPin: false,
    biometricRegistered: false,
    totalBalance: 0,
    darkMode: false,
    cardLinkSkipped: false,
    tapReceiveMode: "quick_accept",
    referralCode: null,
    phone: null,
    phoneVerified: false,
    nickname: null,
    gender: null,
    dateOfBirth: null,
    address: null,
  };
}
function mapProfile(row) {
  return {
    name: row.name,
    notifications: row.notifications,
    biometric: row.biometric,
    cardLinked: row.card_linked,
    cardLast4: row.card_last4,
    avatarUrl: row.avatar_url,
    hasPin: row.has_pin,
    totalBalance: Number(row.total_balance || 0),
    darkMode: !!row.dark_mode,
    cardLinkSkipped: !!row.card_link_skipped,
    tapReceiveMode: row.tap_receive_mode || "quick_accept",
    tapReceiveToken: row.tap_receive_token || null,
    referralCode: row.referral_code || null,
    phone: row.phone || null,
    phoneVerified: !!row.phone_verified,
    nickname: row.nickname || null,
    gender: row.gender || null,
    dateOfBirth: row.date_of_birth || null,
    address: row.address || null,
  };
}
function unmapSettings(partial) {
  const out = {};
  if ("name" in partial) out.name = partial.name;
  if ("notifications" in partial) out.notifications = partial.notifications;
  if ("biometric" in partial) out.biometric = partial.biometric;
  if ("cardLinked" in partial) out.card_linked = partial.cardLinked;
  if ("cardLast4" in partial) out.card_last4 = partial.cardLast4;
  if ("avatarUrl" in partial) out.avatar_url = partial.avatarUrl;
  if ("totalBalance" in partial) out.total_balance = partial.totalBalance;
  if ("darkMode" in partial) out.dark_mode = partial.darkMode;
  if ("cardLinkSkipped" in partial) out.card_link_skipped = partial.cardLinkSkipped;
  if ("tapReceiveMode" in partial) out.tap_receive_mode = partial.tapReceiveMode;
  if ("phone" in partial) out.phone = partial.phone;
  if ("phoneVerified" in partial) out.phone_verified = partial.phoneVerified;
  if ("nickname" in partial) out.nickname = partial.nickname;
  if ("gender" in partial) out.gender = partial.gender;
  if ("dateOfBirth" in partial) out.date_of_birth = partial.dateOfBirth;
  if ("address" in partial) out.address = partial.address;
  return out;
}

// Custom "dotted" QR renderer — the default qrcode-package canvas output is
// flat black-and-white squares; this redraws the same matrix as rounded
// body dots with ring-and-dot finder markers instead, matching Rota's UI.
// Cached so repeated receipt generation doesn't re-fetch the icon each time.
let _logoImagePromise = null;
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function loadLogoImage() {
  if (!_logoImagePromise) {
    _logoImagePromise = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = "/icons/icon-96.png";
    });
  }
  return _logoImagePromise;
}

function drawStyledQR(canvas, text, { size = 200, fg = "#FFFFFF", bg = "#0E0C15" } = {}) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const data = qr.modules.data;
  const cell = size / n;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  function roundedRect(x, y, w, h, r, fillStyle) {
    ctx.fillStyle = fillStyle;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
  }

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  const isFinderZone = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!data[r * n + c] || isFinderZone(r, c)) continue;
      const pad = cell * 0.14;
      const s = cell - pad * 2;
      roundedRect(c * cell + pad, r * cell + pad, s, s, s * 0.4, fg);
    }
  }

  [
    [0, 0],
    [0, n - 7],
    [n - 7, 0],
  ].forEach(([r0, c0]) => {
    const x0 = c0 * cell,
      y0 = r0 * cell,
      outer = 7 * cell;
    roundedRect(x0, y0, outer, outer, outer * 0.22, fg);
    roundedRect(x0 + cell, y0 + cell, outer - cell * 2, outer - cell * 2, (outer - cell * 2) * 0.25, bg);
    const dot = outer - cell * 4;
    roundedRect(x0 + cell * 2, y0 + cell * 2, dot, dot, dot * 0.3, fg);
  });
}

// Blinking eye toggle for the balance figure — periodically does a quick
// squish "blink" while the balance is visible, and stays shut (via the same
// squish, held) once tapped to hide it. One icon, transform-only, so the
// open/close reads as a single continuous motion rather than an icon swap.
function BalanceEyeToggle({ hidden, onToggle }) {
  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    if (hidden) return;
    const id = setInterval(() => {
      setBlinking(true);
      setTimeout(() => setBlinking(false), 160);
    }, 5000);
    return () => clearInterval(id);
  }, [hidden]);
  const closed = hidden || blinking;
  return (
    <button
      onClick={onToggle}
      aria-label={hidden ? "Show balance" : "Hide balance"}
      className="flex items-center justify-center flex-shrink-0"
      style={{ background: "none", border: "none", padding: 2 }}
    >
      <Eye
        size={14}
        color={T.muted}
        style={{ transform: closed ? "scaleY(0.12)" : "scaleY(1)", transition: "transform 0.16s ease", transformOrigin: "center" }}
      />
    </button>
  );
}

// Live camera QR scanner — decodes frames with jsQR rather than pulling in a
// full scanning library, so the camera view stays styled like the rest of
// the sheet instead of a generic embedded widget.
function QrScanner({ onResult, onCancel }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const streamRef = useRef(null);
  const [error, setError] = useState("");
  // Kept invisible (not unmounted, so the ref is always attached for
  // getUserMedia to hand its stream to) until the stream is actually live —
  // an empty <video> element otherwise briefly shows the WebView's own
  // default play-icon placeholder before any frames arrive.
  const [cameraReady, setCameraReady] = useState(false);

  useEffect(() => {
    let alive = true;

    function tick() {
      if (!alive) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if (code?.data) {
          onResult(code.data);
          return;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "environment" } })
      .then((stream) => {
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
        }
        tick();
        setCameraReady(true);
      })
      .catch(() => setError("Couldn't access the camera — check your browser's camera permission for this site."));

    return () => {
      alive = false;
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col items-center gap-3 w-full">
      {error ? (
        <p className="text-xs text-center" style={{ color: T.warn, fontFamily: FONT_BODY }}>
          {error}
        </p>
      ) : (
        <div className="relative rounded-2xl overflow-hidden" style={{ width: 220, height: 220, background: "#000" }}>
          <video
            ref={videoRef}
            muted
            playsInline
            className="w-full h-full"
            style={{ objectFit: "cover", opacity: cameraReady ? 1 : 0 }}
          />
          {!cameraReady && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 size={22} className="animate-spin" color={T.gold} />
            </div>
          )}
          <div
            className="absolute inset-6 rounded-2xl pointer-events-none"
            style={{ border: `2px solid ${T.gold}`, opacity: cameraReady ? 0.7 : 0 }}
          />
        </div>
      )}
      <canvas ref={canvasRef} className="hidden" />
      <button onClick={onCancel} className="text-xs" style={{ color: T.muted, fontFamily: FONT_BODY }}>
        Cancel
      </button>
    </div>
  );
}

/* ---------- Shared bits ---------- */
function AppHeader({ title, onProfile, showAvatar, avatarUrl, name, headerRef }) {
  return (
    <div
      ref={headerRef}
      className="rota-header-safe rota-header-glass flex items-center justify-between px-5 pb-3"
      style={{ background: `${T.ink}B8`, backdropFilter: "blur(20px) saturate(1.5)", WebkitBackdropFilter: "blur(20px) saturate(1.5)" }}
    >
      <h1 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-2xl font-semibold">
        {title}
      </h1>
      {showAvatar && (
        <button
          onClick={onProfile}
          className="rounded-full overflow-hidden flex items-center justify-center transition-transform active:scale-90 flex-shrink-0"
          style={{ width: 36, height: 36, background: T.gold, border: `1px solid ${T.ink3}` }}
        >
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="w-full h-full" style={{ objectFit: "cover" }} />
          ) : (
            <span style={{ fontFamily: FONT_DISPLAY, color: T.ink2 }} className="text-sm font-semibold">
              {(name || "?").charAt(0).toUpperCase()}
            </span>
          )}
        </button>
      )}
    </div>
  );
}

function TabBar({ tab, setTab }) {
  const items = [
    { key: "home", label: "Home", Icon: HomeIcon },
    { key: "schedule", label: "Schedule", Icon: Calendar },
    { key: "todo", label: "To-Do", Icon: CheckSquare },
    { key: "advisor", label: "Advisor", Icon: Sparkles },
    { key: "profile", label: "Profile", Icon: User },
  ];
  return (
    <div
      className="rota-tabbar-safe lg:hidden flex items-center justify-between px-3 flex-shrink-0 fixed bottom-0 left-0 right-0"
      style={{ background: T.ink2, borderTop: `1px solid ${T.ink3}`, paddingTop: 10, zIndex: 15 }}
    >
      {items.map(({ key, label, Icon }) => {
        const active = tab === key;
        return (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="flex flex-col items-center gap-1 flex-1 transition-transform active:scale-90"
          >
            <Icon size={19} color={active ? T.gold : T.muted} strokeWidth={active ? 2.4 : 2} />
            <span
              className="text-xs"
              style={{ fontFamily: FONT_BODY, color: active ? T.gold : T.muted, fontWeight: active ? 600 : 500 }}
            >
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Desktop counterpart to TabBar — a fixed-width sidebar shown from the lg
// breakpoint up, replacing the bottom bar so the extra horizontal space on
// a laptop/desktop screen goes toward real navigation, not empty margin.
function SideNav({ tab, setTab }) {
  const items = [
    { key: "home", label: "Home", Icon: HomeIcon },
    { key: "schedule", label: "Schedule", Icon: Calendar },
    { key: "todo", label: "To-Do", Icon: CheckSquare },
    { key: "advisor", label: "Advisor", Icon: Sparkles },
    { key: "profile", label: "Profile", Icon: User },
  ];
  return (
    <div
      className="hidden lg:flex flex-col flex-shrink-0"
      style={{ width: 220, background: T.ink2, borderRight: `1px solid ${T.ink3}`, padding: "24px 12px" }}
    >
      <div className="flex items-center gap-2 px-2 mb-8">
        <RotaMark size={30} />
        <span style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-base font-semibold">
          Rota
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {items.map(({ key, label, Icon }) => {
          const active = tab === key;
          return (
            <button
              key={key}
              onClick={() => setTab(key)}
              className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors"
              style={{ background: active ? T.ink3 : "transparent" }}
            >
              <Icon size={18} color={active ? T.gold : T.muted} strokeWidth={active ? 2.4 : 2} />
              <span
                className="text-sm"
                style={{ fontFamily: FONT_BODY, color: active ? T.gold : T.muted, fontWeight: active ? 600 : 500 }}
              >
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CategoryChip({ category }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" style={{ fontFamily: FONT_BODY, color: T.muted }}>
      <span className="rounded-full" style={{ width: 6, height: 6, background: categoryColor(category) }} />
      {category}
    </span>
  );
}

/* ---------- Add Money / Send Money ---------- */
// The two directions money moves through a user's Paystack Dedicated
// Virtual Account: funds arriving via any of the usual Nigerian rails
// (bank transfer, card top-up, USSD, QR), and funds leaving via a P2P
// send that draws on the wallet balance instead of charging a linked
// card. Every path here calls the dva-wallet-action function, which a
// real Paystack webhook / Transfers API call triggers in production.

// Demonstrates the two directions money moves once a Paystack Dedicated
// Virtual Account is wired directly into Rota's Home tab: funds arriving
// via any of the usual Nigerian rails (bank transfer, card top-up, USSD,
// QR), and funds leaving via a P2P send that draws on the wallet balance
// instead of charging a linked card. Every path here calls the same
// dva-wallet-action function a real Paystack webhook / Transfers API call
// would trigger in production.

const ADD_MONEY_METHODS = [
  { key: "transfer", label: "Bank Transfer", hint: "Add money via mobile or internet banking", Icon: Landmark },
  { key: "topup", label: "Top-up with Card/Account", hint: "Add money directly from your bank card or account", Icon: CreditCard },
  { key: "ussd", label: "Bank USSD", hint: "With other banks' USSD code", Icon: Smartphone },
  { key: "qr", label: "Scan my QR Code", hint: "Show QR code to any Rota user", Icon: QrCode },
];
const POPULAR_BANKS_FOR_TRANSFER = ["OPay", "Zenith Bank", "United Bank for Africa", "Kuda"];

function SimulateInboundForm({ defaultBank = "", defaultName = "", hideNameBank, submitLabel = "Simulate transfer received", onSubmit }) {
  const [amount, setAmount] = useState("");
  const [name, setName] = useState(defaultName);
  const [bank, setBank] = useState(defaultBank);
  const [submitting, setSubmitting] = useState(false);
  const canSave = Number(amount) > 0;

  async function submit() {
    if (!canSave || submitting) return;
    setSubmitting(true);
    await onSubmit({ amount: Number(amount), name: name.trim() || "Bank transfer", bank: bank.trim() });
    setSubmitting(false);
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
          Amount (₦)
        </label>
        <input
          type="number"
          autoFocus
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="w-full rounded-xl px-3 py-2.5 text-sm"
          style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_MONO }}
        />
      </div>
      {!hideNameBank && (
        <>
          <div>
            <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
              Sender name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. John Doe"
              className="w-full rounded-xl px-3 py-2.5 text-sm"
              style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
            />
          </div>
          <div>
            <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
              Sending bank
            </label>
            <input
              value={bank}
              onChange={(e) => setBank(e.target.value)}
              placeholder="e.g. GTBank"
              className="w-full rounded-xl px-3 py-2.5 text-sm"
              style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
            />
          </div>
        </>
      )}
      <button
        disabled={!canSave || submitting}
        onClick={submit}
        className="w-full rounded-2xl py-3 font-semibold text-sm mt-1 flex items-center justify-center gap-2 transition-transform active:scale-95"
        style={{ background: canSave ? T.gold : T.ink3, color: canSave ? T.ink2 : T.muted, fontFamily: FONT_BODY }}
      >
        {submitting && <Loader2 size={14} className="animate-spin" />}
        {submitLabel}
      </button>
    </div>
  );
}

function AddMoneySheet({ wallet, onClose, onCredited, onClaimed, user }) {
  useBackClose(onClose);
  const [method, setMethod] = useState(null); // null = method list
  const [copied, setCopied] = useState(false);
  const [prefillBank, setPrefillBank] = useState("");
  const [qrTab, setQrTab] = useState("mine"); // mine | scan
  const qrCanvasRef = useRef(null);
  const kbInset = useKeyboardInset();

  useEffect(() => {
    if (method === "qr" && qrTab === "mine" && qrCanvasRef.current) {
      // Standard dark-on-light modules — the polarity scanners are tuned
      // for and read fastest. The dark backdrop that makes it "pop" is the
      // card behind it (see the container below), not the QR itself.
      drawStyledQR(qrCanvasRef.current, wallet.virtual_account_number, { size: 160, fg: "#0B1120", bg: "#FFFFFF" });
    }
  }, [method, qrTab, wallet.virtual_account_number]);

  function copyAccountNumber() {
    navigator.clipboard?.writeText(wallet.virtual_account_number).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const formatted = wallet.virtual_account_number.replace(/(\d{3})(\d{3})(\d{4})/, "$1 $2 $3");
  const active = ADD_MONEY_METHODS.find((m) => m.key === method);

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 20, paddingBottom: kbInset }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 overflow-y-auto max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}`, maxHeight: "88vh" }}>
        <div className="flex items-center gap-2 mb-4">
          {method && (
            <button onClick={() => setMethod(null)} className="flex-shrink-0">
              <ChevronDown size={18} color={T.muted} style={{ transform: "rotate(90deg)" }} />
            </button>
          )}
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold flex-1">
            {active ? active.label : "Add Money"}
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>

        {!method && (
          <div className="flex flex-col">
            {ADD_MONEY_METHODS.map((m) => (
              <button
                key={m.key}
                onClick={() => setMethod(m.key)}
                className="flex items-center gap-3 py-3.5 text-left"
                style={{ borderBottom: `1px solid ${T.ink3}` }}
              >
                <div className="rounded-xl flex items-center justify-center flex-shrink-0" style={{ width: 40, height: 40, background: T.ink }}>
                  <m.Icon size={18} color={T.paper} />
                </div>
                <div className="flex-1 min-w-0">
                  <p style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm font-semibold">
                    {m.label}
                  </p>
                  <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
                    {m.hint}
                  </p>
                </div>
                <ChevronDown size={16} color={T.muted} style={{ transform: "rotate(-90deg)", flexShrink: 0 }} />
              </button>
            ))}
          </div>
        )}

        {method === "transfer" && (
          <div className="flex flex-col gap-4">
            <div>
              <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs mb-1">
                {wallet.virtual_account_bank_name}
              </p>
              <span style={{ fontFamily: FONT_MONO, color: T.paper, letterSpacing: 1 }} className="text-2xl font-semibold block mb-3">
                {formatted}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={copyAccountNumber}
                  className="flex-1 rounded-full py-2.5 text-sm font-semibold flex items-center justify-center gap-2"
                  style={{ background: `${T.ok}22`, color: T.ok, fontFamily: FONT_BODY }}
                >
                  <Copy size={14} /> {copied ? "Copied" : "Copy Number"}
                </button>
                <button
                  onClick={copyAccountNumber}
                  className="flex-1 rounded-full py-2.5 text-sm font-semibold"
                  style={{ background: T.ok, color: "#fff", fontFamily: FONT_BODY }}
                >
                  Share Details
                </button>
              </div>
            </div>

            <div className="rounded-2xl p-3" style={{ background: T.ink, border: `1px solid ${T.ink3}` }}>
              <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs mb-2">
                Tap a bank to prefill it below
              </p>
              <div className="flex gap-3">
                {POPULAR_BANKS_FOR_TRANSFER.map((b) => (
                  <button
                    key={b}
                    onClick={() => {
                      setPrefillBank(b);
                      copyAccountNumber();
                    }}
                  >
                    <BankMonogram name={b} size={36} />
                  </button>
                ))}
              </div>
            </div>

            <SimulateInboundForm key={prefillBank} defaultBank={prefillBank} onSubmit={onCredited} />
          </div>
        )}

        {method === "topup" && (
          <div className="flex flex-col gap-4">
            <p className="text-xs" style={{ color: T.muted, fontFamily: FONT_BODY }}>
              Add money instantly from a debit card or linked account.
            </p>
            <SimulateInboundForm hideNameBank defaultName="Card top-up" submitLabel="Pay" onSubmit={onCredited} />
          </div>
        )}

        {method === "ussd" && (
          <div className="flex flex-col gap-4">
            <div className="rounded-2xl p-4 text-center" style={{ background: T.ink, border: `1px solid ${T.ink3}` }}>
              <p style={{ fontFamily: FONT_MONO, color: T.paper }} className="text-base font-semibold mb-1">
                *901*Amount*{wallet.virtual_account_number}#
              </p>
              <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
                Dial this from any phone on any network to fund this account.
              </p>
            </div>
            <SimulateInboundForm hideNameBank defaultName="USSD transfer" submitLabel="Simulate USSD transfer" onSubmit={onCredited} />
          </div>
        )}

        {method === "qr" && (
          <div className="flex flex-col gap-4">
            <div className="flex rounded-xl p-1" style={{ background: T.ink, border: `1px solid ${T.ink3}` }}>
              {[
                { key: "mine", label: "My QR Code" },
                { key: "scan", label: "Scan QR Code" },
              ].map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setQrTab(opt.key)}
                  className="flex-1 rounded-lg py-2 text-xs font-semibold transition-colors"
                  style={{
                    fontFamily: FONT_BODY,
                    background: qrTab === opt.key ? T.gold : "transparent",
                    color: qrTab === opt.key ? T.ink2 : T.muted,
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {qrTab === "mine" ? (
              <>
                <div className="rounded-2xl p-6 flex flex-col items-center gap-3" style={{ background: "#0B1120", border: `1px solid ${T.ink3}` }}>
                  <div className="rounded-xl overflow-hidden p-2.5" style={{ background: "#FFFFFF" }}>
                    <canvas ref={qrCanvasRef} style={{ width: 160, height: 160, display: "block" }} />
                  </div>
                  <p style={{ fontFamily: FONT_BODY, color: "#94A3B8" }} className="text-xs text-center">
                    Show this to any Rota user to receive a transfer straight into this account.
                  </p>
                </div>
                <SimulateInboundForm hideNameBank defaultName="QR payment" submitLabel="Simulate QR payment" onSubmit={onCredited} />
              </>
            ) : (
              <div className="rounded-2xl p-4" style={{ background: T.ink, border: `1px solid ${T.ink3}` }}>
                <ScanQrToClaim
                  user={user}
                  onCancel={() => setQrTab("mine")}
                  onClaimed={(newBalance) => {
                    onClaimed(newBalance);
                    onClose();
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SendMoneySheet({ wallet, hasPin, hasBiometric, onClose, onSent }) {
  useBackClose(onClose);
  const [step, setStep] = useState("recipient"); // recipient | amount | review
  const [confirming, setConfirming] = useState(false);
  const kbInset = useKeyboardInset();
  const [accountNumber, setAccountNumber] = useState("");
  const [bankCode, setBankCode] = useState("");
  const [bankName, setBankName] = useState("");
  const [banks, setBanks] = useState(cachedBanks || []);
  const [banksLoading, setBanksLoading] = useState(!cachedBanks);
  const [resolvedName, setResolvedName] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [detectMatches, setDetectMatches] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const autoDetectedKeyRef = useRef("");

  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sendError, setSendError] = useState("");

  useEffect(() => {
    if (cachedBanks) return;
    let alive = true;
    supabase.functions.invoke("list-banks", { body: {} }).then(({ data, error }) => {
      if (!alive) return;
      if (!error && data?.banks) {
        cachedBanks = data.banks;
        setBanks(data.banks);
      }
      setBanksLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Same account-number → bank auto-detect pattern used when scheduling a
  // Rota: verify against the chosen bank if one's picked, otherwise try to
  // auto-detect it (like OPay/PalmPay do) from the number alone.
  useEffect(() => {
    setResolveError("");
    setDetectMatches([]);
    if (accountNumber.length !== 10) {
      setResolvedName("");
      return;
    }
    if (bankCode) {
      const key = `${accountNumber}:${bankCode}`;
      if (autoDetectedKeyRef.current === key) return;
      setResolvedName("");
      setResolving(true);
      const handle = setTimeout(async () => {
        const { data, error } = await supabase.functions.invoke("resolve-account", {
          body: { account_number: accountNumber, bank_code: bankCode },
        });
        if (error || !data?.account_name) {
          setResolveError((data && data.error) || "Couldn't verify that account.");
        } else {
          setResolvedName(data.account_name);
        }
        setResolving(false);
      }, 500);
      return () => clearTimeout(handle);
    }
    setResolvedName("");
    setDetecting(true);
    supabase.functions.invoke("detect-bank", { body: { account_number: accountNumber } }).then(({ data, error }) => {
      setDetecting(false);
      if (error || !data?.matches || data.matches.length === 0) return;
      if (data.matches.length === 1) {
        const m = data.matches[0];
        autoDetectedKeyRef.current = `${accountNumber}:${m.bank_code}`;
        setBankCode(m.bank_code);
        setBankName(m.bank_name);
        setResolvedName(m.account_name);
      } else {
        setDetectMatches(data.matches);
      }
    });
  }, [accountNumber, bankCode]);

  function pickDetectedMatch(m) {
    autoDetectedKeyRef.current = `${accountNumber}:${m.bank_code}`;
    setBankCode(m.bank_code);
    setBankName(m.bank_name);
    setResolvedName(m.account_name);
    setDetectMatches([]);
  }
  function pickBank(b) {
    autoDetectedKeyRef.current = "";
    setBankCode(b.code);
    setBankName(b.name);
    setPickerOpen(false);
  }

  const canGoNext = accountNumber.length === 10 && bankCode;
  const breakdown = transferCharge(Number(amount) || 0);
  const insufficient = breakdown.total > Number(wallet.balance || 0);

  async function submitSend() {
    if (!(Number(amount) > 0) || submitting) return;
    setSubmitting(true);
    setSendError("");
    const { data, error } = await supabase.functions.invoke("dva-wallet-action", {
      body: {
        wallet_id: wallet.id,
        action: "debit",
        amount: breakdown.total,
        counterparty_name: resolvedName || "Recipient",
        counterparty_bank: bankName,
      },
    });
    setSubmitting(false);
    if (error || data?.error) {
      setSendError((data && data.error) || "Couldn't complete transfer.");
      return;
    }
    onSent(data.balance);
  }

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 20, paddingBottom: kbInset }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 overflow-y-auto max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}`, maxHeight: "88vh" }}>
        <div className="flex items-center gap-2 mb-4">
          {step !== "recipient" && (
            <button onClick={() => setStep(step === "review" ? "amount" : "recipient")} className="flex-shrink-0">
              <ChevronDown size={18} color={T.muted} style={{ transform: "rotate(90deg)" }} />
            </button>
          )}
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold flex-1">
            {step === "recipient" ? "Transfer to Bank Account" : step === "amount" ? "Send Money" : "Confirm transfer"}
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>

        {step === "recipient" && (
          <div className="flex flex-col gap-3">
            <div>
              <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
                Recipient Account
              </label>
              <input
                value={accountNumber}
                onChange={(e) => {
                  setAccountNumber(e.target.value.replace(/\D/g, "").slice(0, 10));
                  setBankCode("");
                  setBankName("");
                  setResolvedName("");
                  autoDetectedKeyRef.current = "";
                }}
                placeholder="Enter 10 digits Account Number"
                inputMode="numeric"
                className="w-full rounded-xl px-3 py-2.5 text-sm"
                style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_MONO }}
              />
            </div>

            {detecting && (
              <p className="text-xs flex items-center gap-1.5" style={{ color: T.muted, fontFamily: FONT_BODY }}>
                <Loader2 size={12} className="animate-spin" /> Verifying which account this is...
              </p>
            )}

            {detectMatches.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs" style={{ color: T.muted, fontFamily: FONT_BODY }}>
                  {detectMatches.length === 1 ? "We think this is:" : "Found more than one match — which is it?"}
                </p>
                {detectMatches.map((m) => (
                  <button
                    key={m.bank_code}
                    onClick={() => pickDetectedMatch(m)}
                    className="text-left rounded-xl px-3 py-2 text-xs flex items-center gap-2"
                    style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
                  >
                    <BankMonogram name={m.bank_name} size={20} />
                    {m.bank_name} — {m.account_name}
                  </button>
                ))}
              </div>
            )}

            <div>
              <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
                Select Bank
              </label>
              <button
                onClick={() => setPickerOpen(true)}
                disabled={banksLoading}
                className="w-full rounded-xl px-3 py-2.5 text-sm flex items-center justify-between"
                style={{ background: T.ink, border: `1px solid ${T.ink3}`, fontFamily: FONT_BODY }}
              >
                <span className="flex items-center gap-2 min-w-0">
                  {bankName && <BankMonogram name={bankName} />}
                  <span className="truncate" style={{ color: bankName ? T.paper : T.muted }}>
                    {bankName || (banksLoading ? "Loading banks..." : "Select Bank")}
                  </span>
                </span>
                <ChevronDown size={14} color={T.muted} style={{ flexShrink: 0 }} />
              </button>
            </div>

            {resolving && (
              <p className="text-xs flex items-center gap-1.5" style={{ color: T.muted, fontFamily: FONT_BODY }}>
                <Loader2 size={12} className="animate-spin" /> Verifying account...
              </p>
            )}
            {resolvedName && (
              <p className="text-xs flex items-center gap-1.5" style={{ color: T.ok, fontFamily: FONT_BODY }}>
                <Check size={12} /> {resolvedName}
              </p>
            )}
            {resolveError && (
              <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                {resolveError}
              </p>
            )}

            <button
              disabled={!canGoNext}
              onClick={() => setStep("amount")}
              className="w-full rounded-full py-3 font-semibold text-sm mt-2 transition-transform active:scale-95"
              style={{ background: canGoNext ? T.ok : T.ink3, color: canGoNext ? "#fff" : T.muted, fontFamily: FONT_BODY }}
            >
              Next
            </button>
          </div>
        )}

        {step === "amount" && (
          <div className="flex flex-col gap-3">
            <div className="rounded-2xl p-3 flex items-center gap-3" style={{ background: T.ink, border: `1px solid ${T.ink3}` }}>
              <BankMonogram name={bankName} size={32} />
              <div className="min-w-0">
                <p style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm font-medium truncate">
                  {resolvedName || "Recipient"}
                </p>
                <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
                  {accountNumber} · {bankName}
                </p>
              </div>
            </div>
            <div>
              <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
                Amount (₦)
              </label>
              <input
                type="number"
                autoFocus
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full rounded-xl px-3 py-2.5 text-sm"
                style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_MONO }}
              />
            </div>
            <p className="text-xs" style={{ color: T.muted, fontFamily: FONT_BODY }}>
              Available balance: {naira(wallet.balance)}
            </p>
            <button
              disabled={!(Number(amount) > 0)}
              onClick={() => setStep("review")}
              className="w-full rounded-full py-3 font-semibold text-sm mt-1 transition-transform active:scale-95"
              style={{
                background: Number(amount) > 0 ? T.ok : T.ink3,
                color: Number(amount) > 0 ? "#fff" : T.muted,
                fontFamily: FONT_BODY,
              }}
            >
              Continue
            </button>
          </div>
        )}

        {step === "review" && (
          <div className="flex flex-col gap-4">
            <div className="text-center">
              <div style={{ fontFamily: FONT_MONO, color: T.paper }} className="text-3xl font-semibold">
                {nairaExact(breakdown.total)}
              </div>
            </div>

            <div className="rounded-2xl p-4 flex flex-col gap-3" style={{ background: T.ink, border: `1px solid ${T.ink3}` }}>
              <div className="flex items-center justify-between gap-3">
                <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
                  Bank
                </span>
                <span className="flex items-center gap-2 min-w-0">
                  <BankMonogram name={bankName} size={20} />
                  <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm truncate">
                    {bankName}
                  </span>
                </span>
              </div>
              <ReceiptRow label="Account Number" value={accountNumber} mono />
              <ReceiptRow label="Name" value={resolvedName || "Recipient"} />
              <ReceiptRow label="Amount" value={nairaExact(Number(amount))} mono />
              <ReceiptRow label="Fee" value={nairaExact(breakdown.fee)} mono />
              <ReceiptRow label="VAT" value={nairaExact(breakdown.vat)} mono />
              <div className="pt-3 flex items-center justify-between" style={{ borderTop: `1px solid ${T.ink3}` }}>
                <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm font-semibold">
                  Total
                </span>
                <span style={{ fontFamily: FONT_MONO, color: T.paper }} className="text-sm font-semibold">
                  {nairaExact(breakdown.total)}
                </span>
              </div>
            </div>

            <div className="rounded-2xl p-3 flex items-center justify-between" style={{ background: T.ink, border: `1px solid ${T.ink3}` }}>
              <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
                Paying from wallet
              </span>
              <span style={{ fontFamily: FONT_MONO, color: insufficient ? T.warn : T.paper }} className="text-sm">
                {naira(wallet.balance)}
              </span>
            </div>

            {insufficient && (
              <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                Insufficient balance — you need {nairaExact(breakdown.total - Number(wallet.balance || 0))} more.
              </p>
            )}
            {!hasPin && (
              <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                Set a transaction PIN in Profile → Settings before sending money.
              </p>
            )}
            {sendError && (
              <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                {sendError}
              </p>
            )}

            <button
              disabled={submitting || insufficient || !hasPin}
              onClick={() => setConfirming(true)}
              className="w-full rounded-full py-3.5 font-semibold text-sm flex items-center justify-center gap-2 transition-transform active:scale-95"
              style={{
                background: !submitting && !insufficient && hasPin ? T.ok : T.ink3,
                color: !submitting && !insufficient && hasPin ? "#fff" : T.muted,
                fontFamily: FONT_BODY,
              }}
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              Pay
            </button>
          </div>
        )}
      </div>
      {pickerOpen && (
        <BankPicker banks={banks} banksLoading={banksLoading} value={bankCode} onSelect={pickBank} onClose={() => setPickerOpen(false)} />
      )}
      {confirming && (
        <ConfirmSheet
          title="Confirm transfer"
          actionLabel="Pay with PIN"
          hasBiometric={hasBiometric}
          onClose={() => setConfirming(false)}
          onConfirmed={() => {
            setConfirming(false);
            submitSend();
          }}
        />
      )}
    </div>
  );
}

/* ---------- Rota Tap ---------- */
// The sender authorizes an amount with PIN/biometric up front (same
// ConfirmSheet everything else uses), which opens a 10-minute claim window
// on the server for the QR/camera path — works on any phone or laptop, no
// app required on the other end. For a real NFC tap between two Rota
// phones, the roles are flipped from what you'd expect: the RECEIVER
// passively broadcasts their own account identity the whole time (see
// startReceiveBroadcast, module scope) — proven reliable even screen-off/
// app-closed, since that's exactly how sending already worked. The SENDER
// (this screen, always open/foreground since it needs PIN/biometric anyway)
// reads that broadcast with enableReaderMode() — also proven reliable — and
// calls tap-transfer-direct itself. That sidesteps the one thing that
// turned out not to work: Android reliably waking a closed app's own code
// from an NFC tap it didn't initiate.
function TapSendSheet({ wallet, hasPin, hasBiometric, myReceiveToken, onBack, onClose, onClaimed }) {
  useBackClose(onBack || onClose);
  const [step, setStep] = useState("amount"); // amount | confirm | ready | claimed
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [transfer, setTransfer] = useState(null); // { id, token, claimUrl }
  const [claimedBy, setClaimedBy] = useState(null); // { name, avatarUrl }
  const [nfcStatus, setNfcStatus] = useState(null); // null | "unsupported" | "listening" | "tapped"
  const canvasRef = useRef(null);
  const pollRef = useRef(null);
  const hasTappedRef = useRef(false);

  const canSend = Number(amount) > 0 && Number(amount) <= Number(wallet.balance || 0) && hasPin;

  async function createTransfer() {
    setSubmitting(true);
    setError("");
    const { data, error: fnError } = await supabase.functions.invoke("tap-transfer-create", {
      body: { amount: Number(amount) },
    });
    setSubmitting(false);
    if (fnError || !data?.ok) {
      setError((data && data.error) || "Couldn't start this transfer.");
      setStep("amount");
      return;
    }
    const claimUrl = `${window.location.origin}/?tap=${data.token}`;
    setTransfer({ id: data.id, token: data.token, claimUrl });
    setStep("ready");
  }

  // QR drawing + polling for claim status — deliberately re-runs whenever
  // transfer changes, since a tap in Notification/Open app mode (handled by
  // the separate NFC effect below) replaces the QR-code transfer with the
  // one the tap actually created, and this needs to poll *that* one.
  useEffect(() => {
    if (step !== "ready" || !transfer) return;
    if (canvasRef.current) {
      // Standard dark-on-light modules, same reasoning as the receive QR in
      // AddMoneySheet — the dark backdrop is the card, not the QR itself.
      drawStyledQR(canvasRef.current, transfer.claimUrl, { size: 176, fg: "#0B1120", bg: "#FFFFFF" });
    }
    pollRef.current = setInterval(async () => {
      const { data } = await supabase
        .from("tap_transfers")
        .select("status, claimed_by_name, claimed_by_avatar_url")
        .eq("id", transfer.id)
        .single();
      if (data?.status === "claimed") {
        clearInterval(pollRef.current);
        setClaimedBy({ name: data.claimed_by_name, avatarUrl: data.claimed_by_avatar_url });
        const { data: freshWallet } = await supabase.from("dva_wallets").select("balance").eq("id", wallet.id).single();
        if (freshWallet) onClaimed(Number(freshWallet.balance));
        setStep("claimed");
      }
    }, 2500);

    return () => clearInterval(pollRef.current);
  }, [step, transfer, wallet.id, onClaimed]);

  // Listens for another Rota phone's passively-broadcast receive identity —
  // reading (not emitting) is the reliable direction for an NFC tap; see the
  // comment above the component. A successful read completes the transfer
  // directly through the server instead of waiting on a claim.
  //
  // Deliberately only depends on [step], not transfer — a tap in
  // Notification/Open app mode calls setTransfer() below to hand the new
  // transfer to the polling effect above, which would otherwise re-trigger
  // *this* effect too and hand out a fresh, reset hasTappedRef right as it
  // matters most. hasTappedRef guards a real bug: two phones held near each
  // other (or a deliberate second tap out of impatience while the first is
  // still pending accept) kept this listener live for the whole "ready"
  // session, so every additional read created a brand new transfer under the
  // same PIN authorization — confirmed from the database after a live test
  // sent the same amount twice from one approval.
  useEffect(() => {
    if (step !== "ready" || !IS_NATIVE) return;
    hasTappedRef.current = false;
    let nfcListener = null;
    setNfcStatus("listening");
    // This device can't emit its own receive broadcast and actively read
    // someone else's at the same time — free the radio from the former
    // before claiming it for the latter (harmless no-op if it wasn't
    // running yet).
    HCECapacitorPlugin.stopNfcHce().catch(() => {});
    RotaNfcReader.startListening().catch(() => setNfcStatus("unsupported"));
    RotaNfcReader.addListener("tapReceived", async ({ url }) => {
      if (hasTappedRef.current) return;

      let receiveToken = null;
      try {
        receiveToken = new URL(url).searchParams.get("receive");
      } catch {
        // not a URL we care about
      }
      if (!receiveToken) return; // e.g. a stray tag, not a Rota receive broadcast

      hasTappedRef.current = true;
      RotaNfcReader.stopListening().catch(() => {});
      setNfcStatus("tapped");
      // sessionTransferId is the QR code's own transfer, shown on this same
      // screen — passing it lets the server atomically expire it the moment
      // this tap succeeds, so whoever scans the QR afterward correctly gets
      // "no longer valid" instead of also being able to claim the same
      // authorized amount a second time.
      const { data, error: fnError } = await supabase.functions.invoke("tap-transfer-direct", {
        body: { amount: Number(amount), receiveToken, sessionTransferId: transfer?.id },
      });
      if (fnError || !data?.ok) {
        setError((data && data.error) || "That tap didn't go through — try again.");
        // Genuinely failed (not just "still pending") — safe to accept
        // another tap for this same authorized amount.
        hasTappedRef.current = false;
        RotaNfcReader.startListening().catch(() => {});
        setNfcStatus("listening");
        return;
      }

      if (data.status === "completed") {
        setClaimedBy({ name: data.receiverName, avatarUrl: data.receiverAvatarUrl || null });
        onClaimed(Number(data.newBalance));
        setStep("claimed");
      } else {
        // pending (Notification / Open app modes) — hands off to the
        // polling effect above, which picks up this new transfer id.
        setTransfer({ id: data.id, token: data.token, claimUrl: `${window.location.origin}/?tap=${data.token}` });
      }
    }).then((handle) => {
      nfcListener = handle;
    });

    return () => {
      RotaNfcReader.stopListening().catch(() => {});
      nfcListener?.remove();
      startReceiveBroadcast(myReceiveToken); // hand NFC back to passive receiving
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 20 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 overflow-y-auto max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}`, maxHeight: "88vh" }}>
        <div className="flex items-center gap-2 mb-4">
          {step === "amount" && (
            <button onClick={onBack} className="flex-shrink-0">
              <ChevronDown size={18} color={T.muted} style={{ transform: "rotate(90deg)" }} />
            </button>
          )}
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold flex-1">
            Rota Tap
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>

        {step === "amount" && (
          <div className="flex flex-col gap-3">
            <div>
              <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
                Amount (₦)
              </label>
              <input
                type="number"
                autoFocus
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full rounded-xl px-3 py-2.5 text-sm"
                style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_MONO }}
              />
            </div>
            <p className="text-xs" style={{ color: T.muted, fontFamily: FONT_BODY }}>
              Available balance: {naira(wallet.balance)}
            </p>
            {!hasPin && (
              <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                Set a transaction PIN in Profile → Settings before using Rota Tap.
              </p>
            )}
            {Number(amount) > Number(wallet.balance || 0) && (
              <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                That's more than your available balance.
              </p>
            )}
            {error && (
              <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                {error}
              </p>
            )}
            <button
              disabled={!canSend}
              onClick={() => setStep("confirm")}
              className="w-full rounded-full py-3 font-semibold text-sm mt-1 transition-transform active:scale-95"
              style={{ background: canSend ? T.ok : T.ink3, color: canSend ? "#fff" : T.muted, fontFamily: FONT_BODY }}
            >
              Continue
            </button>
          </div>
        )}

        {step === "ready" && transfer && (
          <div className="flex flex-col items-center gap-4 text-center">
            <div style={{ fontFamily: FONT_MONO, color: T.paper }} className="text-2xl font-semibold">
              {naira(Number(amount))}
            </div>

            <div className="rounded-2xl p-4" style={{ background: "#0B1120", border: `1px solid ${T.ink3}` }}>
              <div className="rounded-xl p-2.5" style={{ background: "#FFFFFF" }}>
                <canvas ref={canvasRef} style={{ width: 176, height: 176, display: "block" }} />
              </div>
            </div>
            {nfcStatus === "listening" || nfcStatus === "tapped" ? (
              <p className="text-xs flex items-center gap-1.5 justify-center" style={{ color: T.ok, fontFamily: FONT_BODY }}>
                <Wifi size={13} style={{ transform: "rotate(90deg)" }} />
                {nfcStatus === "tapped" ? "Tapped! Completing…" : "Hold the backs of your phones together, or have them scan the QR code."}
              </p>
            ) : (
              <p className="text-xs" style={{ color: T.muted, fontFamily: FONT_BODY }}>
                Have them scan this with their camera — works on any phone or laptop. Link expires in 10 minutes.
              </p>
            )}
            <p className="text-xs flex items-center gap-1.5" style={{ color: T.muted, fontFamily: FONT_BODY }}>
              <Loader2 size={11} className="animate-spin" /> Waiting for them to accept…
            </p>
          </div>
        )}

        {step === "claimed" && (
          <div className="flex flex-col items-center gap-3 text-center py-4">
            {claimedBy?.avatarUrl ? (
              <img src={claimedBy.avatarUrl} alt="" className="rounded-full" style={{ width: 44, height: 44, objectFit: "cover" }} />
            ) : (
              <div className="rounded-full flex items-center justify-center" style={{ width: 44, height: 44, background: T.ok }}>
                <Check size={22} color="#fff" />
              </div>
            )}
            <p style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
              {naira(Number(amount))} sent
            </p>
            {claimedBy?.name && (
              <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-sm -mt-1">
                Accepted by {claimedBy.name}
              </p>
            )}
            <button
              onClick={onClose}
              className="w-full rounded-full py-3 font-semibold text-sm mt-2 transition-transform active:scale-95"
              style={{ background: T.gold, color: T.ink2, fontFamily: FONT_BODY }}
            >
              Done
            </button>
          </div>
        )}
      </div>
      {step === "confirm" && (
        <ConfirmSheet
          title="Confirm Rota Tap"
          actionLabel="Confirm with PIN"
          hasBiometric={hasBiometric}
          onBack={() => setStep("amount")}
          onClose={onClose}
          onConfirmed={() => {
            createTransfer();
          }}
        />
      )}
    </div>
  );
}

// Simple two-option chooser shown when Rota Tap is opened from Home —
// keeps TapSendSheet and TapReceiveSheet as separate, focused components
// rather than one sheet trying to branch internally.
function RotaTapChooser({ onSend, onReceive, onClose }) {
  useBackClose(onClose);
  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 20 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <div className="flex items-center gap-2 mb-4">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold flex-1">
            Rota Tap
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>
        <div className="flex flex-col gap-3">
          <button
            onClick={onSend}
            className="rounded-2xl p-4 flex items-center gap-3 text-left transition-transform active:scale-95"
            style={{ background: T.gold }}
          >
            <span className="rounded-full flex items-center justify-center flex-shrink-0" style={{ width: 34, height: 34, background: "rgba(0,0,0,0.14)" }}>
              <ArrowUpRight size={16} color={T.ink2} />
            </span>
            <span>
              <p style={{ fontFamily: FONT_BODY, color: T.ink2 }} className="text-sm font-semibold">Send</p>
              <p style={{ fontFamily: FONT_BODY, color: T.ink2 }} className="text-xs opacity-80">Authorize an amount, then show a QR code</p>
            </span>
          </button>
          <button
            onClick={onReceive}
            className="rounded-2xl p-4 flex items-center gap-3 text-left transition-transform active:scale-95"
            style={{ background: T.ink, border: `1px solid ${T.ink3}` }}
          >
            <span className="rounded-full flex items-center justify-center flex-shrink-0" style={{ width: 34, height: 34, background: T.ink3 }}>
              <ArrowDownLeft size={16} color={T.paper} />
            </span>
            <span>
              <p style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm font-semibold">Receive</p>
              <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">Scan the sender's QR code with your camera</p>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

// Shared by Rota Tap's Receive sheet and Add Money's "Scan QR Code" tab.
// Camera-only: NFC has no phone-to-phone data exchange primitive in any
// browser (Web NFC only reads/writes passive tags, never another active
// device), so a "listen for NFC" path here would never fire on any device.
// The camera works identically on a phone or a laptop webcam — no special
// hardware needed on either side. Callers only ever mount this while
// already signed in, so it goes straight to the Accept UI.
function ScanQrToClaim({ user, onClaimed, onCancel }) {
  const [scannedToken, setScannedToken] = useState(null);

  function handleScanResult(data) {
    try {
      const t = new URL(data).searchParams.get("tap");
      setScannedToken(t || data);
    } catch {
      setScannedToken(data);
    }
  }

  if (scannedToken) {
    return <TapClaimBody token={scannedToken} user={user} onDone={(newBalance) => onClaimed(newBalance)} />;
  }
  return (
    <div className="flex flex-col items-center gap-3">
      <QrScanner onResult={handleScanResult} onCancel={onCancel} />
      <p className="text-xs text-center" style={{ color: T.muted, fontFamily: FONT_BODY }}>
        Point your camera at the sender's QR code — works from a phone or a laptop webcam.
      </p>
    </div>
  );
}

function TapReceiveSheet({ user, onBack, onClose, onClaimed }) {
  useBackClose(onBack || onClose);
  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 20 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 overflow-y-auto max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}`, maxHeight: "88vh" }}>
        <div className="flex items-center gap-2 mb-4">
          <button onClick={onBack} className="flex-shrink-0">
            <ChevronDown size={18} color={T.muted} style={{ transform: "rotate(90deg)" }} />
          </button>
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold flex-1">
            Scan to receive
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>
        <ScanQrToClaim
          user={user}
          onCancel={onClose}
          onClaimed={(newBalance) => {
            onClaimed(newBalance);
            onClose();
          }}
        />
      </div>
    </div>
  );
}

function ReferralSheet({ referralCode, onClose }) {
  useBackClose(onClose);
  const [copied, setCopied] = useState(false);
  const link = referralCode ? `${OAUTH_REDIRECT_URL}?ref=${referralCode}` : "";

  function copyLink() {
    if (!link) return;
    navigator.clipboard?.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 20 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 overflow-y-auto max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}`, maxHeight: "80vh" }}>
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            Refer & Earn
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>
        <div className="rounded-2xl p-5 mb-4 flex flex-col items-center text-center" style={{ background: T.ink, border: `1px solid ${T.ink3}` }}>
          <div className="rounded-full flex items-center justify-center mb-3" style={{ width: 56, height: 56, background: `${T.gold}1F` }}>
            <Gift size={26} color={T.gold} />
          </div>
          <p style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm font-medium mb-1">
            Invite friends to Rota
          </p>
          <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
            Share your link below — anyone who joins through it is tied to your account.
          </p>
        </div>
        {referralCode ? (
          <>
            <div className="rounded-xl px-3 py-2.5 mb-3 flex items-center justify-between gap-2" style={{ background: T.ink, border: `1px solid ${T.ink3}` }}>
              <span style={{ fontFamily: FONT_MONO, color: T.paper }} className="text-xs truncate">
                {link}
              </span>
            </div>
            <button
              onClick={copyLink}
              className="w-full rounded-2xl py-3 font-semibold text-sm flex items-center justify-center gap-2 transition-transform active:scale-95"
              style={{ background: T.gold, color: T.ink2, fontFamily: FONT_BODY }}
            >
              <Copy size={15} /> {copied ? "Copied" : "Copy link"}
            </button>
          </>
        ) : (
          <p className="text-xs text-center" style={{ color: T.muted, fontFamily: FONT_BODY }}>
            Setting up your referral link — check back in a moment.
          </p>
        )}
      </div>
    </div>
  );
}

// Airtime/data/electricity share the same shape (pick a target, pick an
// amount, confirm) even though electricity's target is a meter number and
// disco rather than a phone number and network — one sheet parameterized by
// mode instead of three near-identical ones. No provider is wired up yet,
// so this walks the whole flow and stops at an honest "not live yet" rather
// than pretending to charge anything.
// Full page rather than a bottom sheet, matching the reference layout — the
// contact picker uses the plugin's native pickContact (a system picker
// intent), which still requires READ_CONTACTS/WRITE_CONTACTS to be declared
// in AndroidManifest.xml even though only a single contact is ever read.
function BillsPurchaseSheet({ mode, onClose }) {
  useBackClose(onClose);
  const [step, setStep] = useState("form"); // form | confirm | notLive
  const [phone, setPhone] = useState("");
  const [network, setNetwork] = useState(null);
  const [disco, setDisco] = useState(DISCOS[0]);
  const [meterNumber, setMeterNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [bundle, setBundle] = useState(null);
  const [dataTab, setDataTab] = useState(DATA_TABS[0]);
  const [contactError, setContactError] = useState("");
  const [networkManual, setNetworkManual] = useState(false);
  const [networkPickerOpen, setNetworkPickerOpen] = useState(false);

  const title = mode === "airtime" ? "Airtime" : mode === "data" ? "Mobile Data" : "Electricity";
  const Icon = mode === "airtime" ? Smartphone : mode === "data" ? Wifi : Zap;
  const plan = bundle ? DATA_PLANS_BY_TAB[dataTab]?.find((p) => p.value === bundle) : null;

  useEffect(() => {
    if (mode === "electricity" || networkManual) return;
    setNetwork(phone.length >= 4 ? detectNetwork(phone) : null);
  }, [phone, mode, networkManual]);

  const canContinue =
    mode === "electricity" ? meterNumber.length >= 6 && Number(amount) > 0 : phone.length === 11 && (mode === "data" ? !!bundle : Number(amount) > 0);

  async function pickFromContacts() {
    setContactError("");
    if (!IS_NATIVE) {
      setContactError("Contact picking only works in the installed app.");
      return;
    }
    try {
      const { contact } = await Contacts.pickContact({ projection: { phones: true } });
      const raw = contact?.phones?.[0]?.number || "";
      const digits = raw.replace(/\D/g, "").slice(-11);
      if (digits.length !== 11) {
        setContactError("That contact doesn't have a Nigerian number saved.");
        return;
      }
      setNetworkManual(false);
      setPhone(digits);
    } catch (e) {
      const cancelled = String(e?.message || "").toLowerCase().includes("cancel");
      if (!cancelled) setContactError("Couldn't open contacts.");
    }
  }

  return (
    <div className="absolute inset-0 flex justify-center" style={{ zIndex: 26, background: T.ink }}>
      <div className="relative w-full max-w-lg h-full overflow-y-auto flex flex-col">
        <div className="flex items-center gap-3 px-5" style={{ paddingTop: "max(24px, env(safe-area-inset-top))" }}>
          <button onClick={onClose} className="flex-shrink-0">
            <ChevronDown size={20} color={T.paper} style={{ transform: "rotate(90deg)" }} />
          </button>
          <h1 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-xl font-semibold flex-1">
            {title}
          </h1>
          <Icon size={18} color={T.gold} />
        </div>

        <div className="px-5 py-5 flex flex-col gap-4 flex-1">
          {step === "notLive" ? (
            <div className="flex flex-col items-center text-center gap-3 py-10">
              <div className="rounded-full flex items-center justify-center" style={{ width: 56, height: 56, background: `${T.warn}1F` }}>
                <Clock size={26} color={T.warn} />
              </div>
              <p style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm font-medium">
                Not live yet
              </p>
              <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs max-w-xs">
                {title} isn't connected to a provider yet — this screen is ready to go the moment one is set up.
              </p>
              <button
                onClick={onClose}
                className="w-full rounded-2xl py-3 font-semibold text-sm mt-2 transition-transform active:scale-95"
                style={{ background: T.ink2, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
              >
                Close
              </button>
            </div>
          ) : step === "confirm" ? (
            <>
              <div className="rounded-2xl p-4 flex flex-col gap-2" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
                {mode === "electricity" ? (
                  <>
                    <ReceiptRow label="Disco" value={disco} />
                    <ReceiptRow label="Meter number" value={meterNumber} mono />
                  </>
                ) : (
                  <>
                    <ReceiptRow label="Network" value={network || "Unknown — verify before buying"} />
                    <ReceiptRow label="Phone number" value={phone} mono />
                  </>
                )}
                <ReceiptRow label="Amount" value={mode === "data" ? `${plan?.label} — ${plan?.sub}` : naira(Number(amount) || 0)} mono />
              </div>
              <button
                onClick={() => setStep("notLive")}
                className="w-full rounded-2xl py-3 font-semibold text-sm transition-transform active:scale-95"
                style={{ background: T.gold, color: T.ink2, fontFamily: FONT_BODY }}
              >
                Pay
              </button>
              <button onClick={() => setStep("form")} className="text-xs text-center" style={{ color: T.muted, fontFamily: FONT_BODY }}>
                Back
              </button>
            </>
          ) : (
            <>
              {mode === "electricity" ? (
                <div className="rounded-2xl p-3 flex flex-col gap-3" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
                  <select
                    value={disco}
                    onChange={(e) => setDisco(e.target.value)}
                    className="w-full rounded-xl px-3 py-2.5 text-sm"
                    style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
                  >
                    {DISCOS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                  <input
                    value={meterNumber}
                    onChange={(e) => setMeterNumber(e.target.value.replace(/\D/g, ""))}
                    placeholder="Prepaid meter number"
                    inputMode="numeric"
                    className="w-full rounded-xl px-3 py-2.5 text-lg font-semibold"
                    style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_MONO }}
                  />
                </div>
              ) : (
                <div className="relative">
                  <div className="rounded-2xl p-3 flex items-center gap-2" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
                    {phone.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setNetworkPickerOpen((v) => !v)}
                        className="rounded-full pl-1 pr-2.5 py-1 text-xs font-semibold flex-shrink-0 flex items-center gap-1.5"
                        style={{ background: `${T.gold}22`, color: T.gold, fontFamily: FONT_BODY }}
                      >
                        {network ? (
                          <span
                            className="rounded-full flex-shrink-0 overflow-hidden flex items-center justify-center"
                            style={{ width: 18, height: 18, background: "#fff" }}
                          >
                            <img src={NETWORK_LOGOS[network]} alt="" className="w-full h-full object-contain p-[1px]" />
                          </span>
                        ) : null}
                        {network || "Select"}
                      </button>
                    )}
                    <input
                      value={phone}
                      onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 11))}
                      placeholder="080..."
                      inputMode="numeric"
                      className="flex-1 min-w-0 bg-transparent text-lg font-semibold"
                      style={{ color: T.paper, fontFamily: FONT_MONO, outline: "none" }}
                    />
                    <button onClick={pickFromContacts} className="flex-shrink-0 rounded-lg p-1.5" style={{ background: T.ink, border: `1px solid ${T.ink3}` }}>
                      <User size={16} color={T.gold} />
                    </button>
                  </div>
                  {networkPickerOpen && (
                    <div
                      className="absolute left-3 top-full mt-1 rounded-xl overflow-hidden z-10"
                      style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}
                    >
                      {Object.keys(NETWORK_PREFIXES).map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => {
                            setNetwork(n);
                            setNetworkManual(true);
                            setNetworkPickerOpen(false);
                          }}
                          className="w-full flex items-center gap-2.5 text-left px-4 py-2.5 text-sm"
                          style={{ color: n === network ? T.gold : T.paper, fontFamily: FONT_BODY }}
                        >
                          <span
                            className="rounded-full flex-shrink-0 overflow-hidden flex items-center justify-center"
                            style={{ width: 22, height: 22, background: "#fff" }}
                          >
                            <img src={NETWORK_LOGOS[n]} alt="" className="w-full h-full object-contain p-[2px]" />
                          </span>
                          {n}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {contactError && (
                <p className="text-xs -mt-2" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                  {contactError}
                </p>
              )}
              {mode !== "electricity" && phone.length >= 4 && !network && (
                <p className="text-xs -mt-2 flex items-center gap-1.5" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                  Couldn't detect a network — tap the chip to select one
                </p>
              )}

              {mode === "data" ? (
                <>
                  <div className="flex gap-4 border-b" style={{ borderColor: T.ink3 }}>
                    {DATA_TABS.map((tab) => (
                      <button
                        key={tab}
                        onClick={() => {
                          setDataTab(tab);
                          setBundle(null);
                        }}
                        className="pb-2 text-sm font-semibold"
                        style={{
                          fontFamily: FONT_BODY,
                          color: dataTab === tab ? T.gold : T.muted,
                          borderBottom: dataTab === tab ? `2px solid ${T.gold}` : "2px solid transparent",
                        }}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {DATA_PLANS_BY_TAB[dataTab].map((p) => (
                      <button
                        key={p.value}
                        onClick={() => setBundle(p.value)}
                        className="rounded-xl p-3 flex flex-col items-center gap-0.5"
                        style={{ background: T.ink2, border: `1px solid ${bundle === p.value ? T.gold : T.ink3}` }}
                      >
                        <span style={{ fontFamily: FONT_MONO, color: T.paper }} className="text-base font-bold">
                          {p.label}
                        </span>
                        <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-[11px]">
                          {p.sub}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
                    {mode === "electricity" ? "Amount" : "Top up amount"}
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    {AIRTIME_PRESETS.map((amt) => (
                      <button
                        key={amt}
                        onClick={() => setAmount(String(amt))}
                        className="rounded-xl py-3 flex flex-col items-center"
                        style={{ background: T.ink2, border: `1px solid ${Number(amount) === amt ? T.gold : T.ink3}` }}
                      >
                        <span style={{ fontFamily: FONT_MONO, color: Number(amount) === amt ? T.gold : T.paper }} className="text-lg font-bold">
                          {naira(amt)}
                        </span>
                      </button>
                    ))}
                  </div>
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="Or enter an amount"
                    className="w-full rounded-xl px-3 py-2.5 text-sm"
                    style={{ background: T.ink2, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_MONO }}
                  />
                </>
              )}

              <button
                disabled={!canContinue}
                onClick={() => setStep("confirm")}
                className="w-full rounded-2xl py-3 font-semibold text-sm mt-1 transition-transform active:scale-95"
                style={{ background: canContinue ? T.gold : T.ink2, color: canContinue ? T.ink2 : T.muted, fontFamily: FONT_BODY }}
              >
                Continue
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- Welcome ---------- */
function WelcomeScreen({ onNext }) {
  return (
    <div className="h-full flex flex-col justify-between px-7" style={{ background: T.ink, paddingTop: "max(40px, env(safe-area-inset-top))", paddingBottom: "max(40px, env(safe-area-inset-bottom))" }}>
      <div>
        <div className="flex items-center gap-2">
          <RotaMark size={34} />
          <span style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            Rota
          </span>
        </div>
      </div>

      <div>
        <h1
          style={{ fontFamily: FONT_DISPLAY, color: T.paper, lineHeight: 1.08 }}
          className="text-4xl font-semibold mb-4"
        >
          Money,
          <br />
          on schedule.
        </h1>
        <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-sm leading-relaxed max-w-xs">
          Plan your month once. Rota pays it out on time, every time — and tells you where every naira is going.
        </p>
      </div>

      <div>
        <button
          onClick={onNext}
          className="w-full rounded-2xl py-3.5 font-semibold text-sm transition-transform active:scale-95"
          style={{ background: T.gold, color: T.ink2, fontFamily: FONT_BODY, boxShadow: `0 10px 24px -8px ${T.gold}` }}
        >
          Get started
        </button>
      </div>
    </div>
  );
}

/* ---------- Link account ---------- */
function LinkScreen({ email, onLinked, onSkip }) {
  const [status, setStatus] = useState("idle"); // idle | processing | error
  const [errorMsg, setErrorMsg] = useState("");

  async function verifyOnServer(reference) {
    try {
      const { data, error } = await supabase.functions.invoke("verify-card-link", { body: { reference } });
      if (error || !data?.success) {
        setStatus("error");
        setErrorMsg((data && data.error) || "Couldn't confirm the card. Try again.");
        return;
      }
      onLinked(data.last4);
    } catch (e) {
      setStatus("error");
      setErrorMsg("Couldn't confirm the card. Try again.");
    }
  }

  function startLink() {
    if (!window.PaystackPop) {
      setStatus("error");
      setErrorMsg("Payment system is still loading — try again in a moment.");
      return;
    }
    setStatus("processing");
    setErrorMsg("");
    const reference = `rota_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const handler = window.PaystackPop.setup({
      key: PAYSTACK_PUBLIC_KEY,
      email,
      amount: 5000,
      currency: "NGN",
      ref: reference,
      callback: function (response) {
        verifyOnServer(response.reference);
      },
      onClose: function () {
        setStatus((s) => (s === "processing" ? "idle" : s));
      },
    });
    handler.openIframe();
  }

  return (
    <div className="h-full flex flex-col px-6" style={{ background: T.ink, paddingTop: "max(32px, env(safe-area-inset-top))", paddingBottom: "max(32px, env(safe-area-inset-bottom))" }}>
      <h1 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-2xl font-semibold mb-1">
        Link your card
      </h1>
      <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-sm mb-6">
        Add the card you spend from. Rota uses it to run your scheduled payments.
      </p>

      <div
        className="rounded-2xl p-5 mb-6"
        style={{ background: `linear-gradient(135deg, ${T.ink3}, ${T.ink2})`, border: `1px solid ${T.ink3}` }}
      >
        <div className="flex items-center justify-between mb-8">
          <div className="rounded" style={{ width: 34, height: 24, background: T.goldSoft }} />
          <CreditCard size={20} color={T.muted} />
        </div>
        <div style={{ fontFamily: FONT_MONO, color: T.paper, letterSpacing: 2 }} className="text-lg mb-3">
          •••• •••• •••• ••••
        </div>
        <div className="flex justify-between">
          <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
            CARDHOLDER
          </span>
          <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
            SECURED BY PAYSTACK
          </span>
        </div>
      </div>

      <div className="flex-1 flex flex-col justify-center gap-3">
        <p className="text-xs flex items-start gap-1.5" style={{ color: T.muted, fontFamily: FONT_BODY }}>
          <ShieldCheck size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          Tapping below opens Paystack's secure checkout. A small ₦50 verification charge confirms the card and
          saves it for future scheduled payments — Rota never sees or stores your card details directly.
        </p>
        {status === "error" && (
          <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
            {errorMsg}
          </p>
        )}
      </div>

      <div className="mt-4">
        <button
          onClick={startLink}
          disabled={status === "processing"}
          className="w-full rounded-2xl py-3.5 font-semibold text-sm mb-3 transition-transform active:scale-95"
          style={{ background: T.gold, color: T.ink2, fontFamily: FONT_BODY, boxShadow: `0 10px 24px -8px ${T.gold}` }}
        >
          {status === "processing" ? "Confirming..." : "Link securely"}
        </button>
        <button onClick={onSkip} className="w-full text-center text-xs py-1" style={{ color: T.muted, fontFamily: FONT_BODY }}>
          Skip for now
        </button>
      </div>
    </div>
  );
}

/* ---------- Home tab ---------- */
function HomeTab({
  payments,
  settings,
  goTab,
  onUpdate,
  user,
  hasBiometricConfirm,
  wallet,
  walletLoading,
  walletTxns,
  onWalletChange,
  onReloadWalletTxns,
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [addMoneyOpen, setAddMoneyOpen] = useState(false);
  const [sendMoneyOpen, setSendMoneyOpen] = useState(false);
  const [tapMode, setTapMode] = useState(null); // null | choose | send | receive
  const [walletHistoryOpen, setWalletHistoryOpen] = useState(false);
  const [balanceHidden, setBalanceHidden] = useState(false);
  const [walletReceiptFor, setWalletReceiptFor] = useState(null);
  const [referralOpen, setReferralOpen] = useState(false);
  const [billsMode, setBillsMode] = useState(null); // null | "airtime" | "data" | "electricity"

  const failedCount = payments.filter((p) => p.status === "failed").length;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  function refreshWalletBalance(newBalance) {
    onWalletChange((prev) => (prev ? { ...prev, balance: newBalance } : prev));
    if (wallet) onReloadWalletTxns(wallet.id);
  }

  return (
    <div className="px-5 pb-4 flex flex-col gap-4">
      <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-sm -mt-1">
        {greeting}, {settings.name}
      </p>

      {failedCount > 0 && (
        <button
          onClick={() => goTab("schedule")}
          className="rounded-2xl p-3.5 flex items-center gap-3 text-left"
          style={{ background: `${T.warn}1A`, border: `1px solid ${T.warn}` }}
        >
          <Clock size={16} color={T.warn} />
          <span style={{ fontFamily: FONT_BODY, color: T.warn }} className="text-xs font-medium">
            {failedCount} Rota{failedCount > 1 ? "s" : ""} failed — tap to review
          </span>
        </button>
      )}

      <div className="rounded-2xl p-4 flex items-center justify-between gap-3" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <div className="min-w-0">
          <span className="flex items-center gap-1.5" style={{ fontFamily: FONT_BODY, color: T.muted }}>
            <span className="text-xs">Balance</span>
            <BalanceEyeToggle hidden={balanceHidden} onToggle={() => setBalanceHidden((v) => !v)} />
          </span>
          {walletLoading ? (
            <div className="py-1.5">
              <Loader2 size={18} className="animate-spin" color={T.muted} />
            </div>
          ) : (
            <div style={{ fontFamily: FONT_MONO, color: T.paper }} className="text-2xl font-semibold">
              {balanceHidden ? "₦ • • • • • •" : naira(wallet?.balance || 0)}
            </div>
          )}
        </div>
        <button
          onClick={() => setWalletHistoryOpen(true)}
          disabled={!wallet}
          className="flex flex-col items-center gap-1 flex-shrink-0 rounded-xl px-3 py-2 transition-transform active:scale-95"
          style={{ background: T.ink, border: `1px solid ${T.ink3}` }}
        >
          <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-xs font-medium">
            History
          </span>
          <ArrowLeftRight size={15} color={T.gold} />
        </button>
      </div>

      <div className="flex gap-3">
        <button
          onClick={() => setAddMoneyOpen(true)}
          disabled={!wallet}
          className="flex-1 rounded-2xl py-3 flex items-center justify-center gap-2.5 transition-transform active:scale-95"
          style={{ background: T.gold }}
        >
          <span
            className="rounded-full flex items-center justify-center flex-shrink-0"
            style={{ width: 24, height: 24, background: "rgba(0,0,0,0.14)" }}
          >
            <ArrowDownLeft size={14} color={T.ink2} strokeWidth={2.6} />
          </span>
          <span style={{ fontFamily: FONT_BODY, color: T.ink2 }} className="text-sm font-semibold">
            Add Money
          </span>
        </button>
        <button
          onClick={() => setSendMoneyOpen(true)}
          disabled={!wallet}
          className="flex-1 rounded-2xl py-3 flex items-center justify-center gap-2.5 transition-transform active:scale-95"
          style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}
        >
          <span
            className="rounded-full flex items-center justify-center flex-shrink-0"
            style={{ width: 24, height: 24, background: T.ink3 }}
          >
            <ArrowUpRight size={14} color={T.paper} strokeWidth={2.6} />
          </span>
          <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm font-semibold">
            Send Money
          </span>
        </button>
      </div>

      <div className="flex justify-center">
        <button
          onClick={() => setTapMode("choose")}
          disabled={!wallet}
          className="w-1/2 rounded-2xl py-3 flex items-center justify-center gap-2 transition-transform active:scale-95"
          style={{ background: `${T.gold}1F`, border: `1.5px solid ${T.gold}` }}
        >
          <Wifi size={15} color={T.gold} strokeWidth={2.6} style={{ transform: "rotate(90deg)" }} />
          <span style={{ fontFamily: FONT_BODY, color: T.gold }} className="text-sm font-semibold">
            Rota Tap
          </span>
        </button>
      </div>

      {walletTxns.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
              Wallet activity
            </p>
            {walletTxns.length > 2 && (
              <button
                onClick={() => setWalletHistoryOpen(true)}
                className="text-xs font-medium"
                style={{ color: T.gold, fontFamily: FONT_BODY }}
              >
                See all
              </button>
            )}
          </div>
          <div className="flex flex-col gap-2">
            {walletTxns.slice(0, 2).map((t) => (
              <div
                key={t.id}
                onClick={() => setWalletReceiptFor(t)}
                className="rounded-xl p-3 flex items-center justify-between cursor-pointer"
                style={{ background: T.ink2 }}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div
                    className="rounded-full flex items-center justify-center flex-shrink-0"
                    style={{ width: 22, height: 22, background: t.type === "credit" ? T.ok : T.ink3 }}
                  >
                    {t.type === "credit" ? <Check size={12} color={T.ink} /> : <Clock size={12} color={T.muted} />}
                  </div>
                  <div className="min-w-0">
                    <p style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm truncate">
                      {t.description ||
                        (t.type === "credit"
                          ? `From ${t.counterparty_name || "bank transfer"}`
                          : `To ${t.counterparty_name || "recipient"}`)}
                    </p>
                    {t.counterparty_bank && (
                      <p className="text-xs" style={{ color: T.muted, fontFamily: FONT_BODY }}>
                        {t.counterparty_bank}
                      </p>
                    )}
                  </div>
                </div>
                <span
                  style={{ fontFamily: FONT_MONO, color: t.type === "credit" ? T.ok : T.paper }}
                  className="text-sm flex-shrink-0"
                >
                  {t.type === "credit" ? "+" : "-"}
                  {naira(t.amount)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-2xl p-3" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => goTab("schedule")}
            className="rounded-xl py-3 flex flex-col items-center gap-1.5 transition-transform active:scale-95"
            style={{ background: T.ink, border: `1px solid ${T.ink3}` }}
          >
            <Plus size={16} color={T.gold} />
            <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-xs">
              Schedule
            </span>
          </button>
          <button
            onClick={() => goTab("todo")}
            className="rounded-xl py-3 flex flex-col items-center gap-1.5 transition-transform active:scale-95"
            style={{ background: T.ink, border: `1px solid ${T.ink3}` }}
          >
            <CheckSquare size={16} color={T.gold} />
            <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-xs">
              To-Do
            </span>
          </button>
          <button
            onClick={() => setReferralOpen(true)}
            className="rounded-xl py-3 flex flex-col items-center gap-1.5 transition-transform active:scale-95"
            style={{ background: T.ink, border: `1px solid ${T.ink3}` }}
          >
            <Gift size={16} color={T.gold} />
            <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-xs">
              Refer & Earn
            </span>
          </button>
          <button
            onClick={() => setBillsMode("airtime")}
            className="rounded-xl py-3 flex flex-col items-center gap-1.5 transition-transform active:scale-95"
            style={{ background: T.ink, border: `1px solid ${T.ink3}` }}
          >
            <Smartphone size={16} color={T.gold} />
            <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-xs">
              Airtime
            </span>
          </button>
          <button
            onClick={() => setBillsMode("data")}
            className="rounded-xl py-3 flex flex-col items-center gap-1.5 transition-transform active:scale-95"
            style={{ background: T.ink, border: `1px solid ${T.ink3}` }}
          >
            <Wifi size={16} color={T.gold} />
            <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-xs">
              Data
            </span>
          </button>
          <button
            onClick={() => setBillsMode("electricity")}
            className="rounded-xl py-3 flex flex-col items-center gap-1.5 transition-transform active:scale-95"
            style={{ background: T.ink, border: `1px solid ${T.ink3}` }}
          >
            <Zap size={16} color={T.gold} />
            <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-xs">
              Electricity
            </span>
          </button>
        </div>
      </div>

      {historyOpen && (
        <TransactionHistorySheet payments={payments} senderName={settings.name} onClose={() => setHistoryOpen(false)} />
      )}
      {addMoneyOpen && wallet && (
        <AddMoneySheet
          wallet={wallet}
          user={user}
          onClose={() => setAddMoneyOpen(false)}
          onCredited={async ({ amount, name, bank }) => {
            const { data } = await supabase.functions.invoke("dva-wallet-action", {
              body: { wallet_id: wallet.id, action: "credit", amount, counterparty_name: name, counterparty_bank: bank },
            });
            if (data?.balance !== undefined) refreshWalletBalance(data.balance);
            setAddMoneyOpen(false);
          }}
          onClaimed={(newBalance) => refreshWalletBalance(newBalance)}
        />
      )}
      {sendMoneyOpen && wallet && (
        <SendMoneySheet
          wallet={wallet}
          hasPin={settings.hasPin}
          hasBiometric={hasBiometricConfirm}
          onClose={() => setSendMoneyOpen(false)}
          onSent={(newBalance) => {
            refreshWalletBalance(newBalance);
            setSendMoneyOpen(false);
          }}
        />
      )}
      {walletHistoryOpen && (
        <WalletHistorySheet
          transactions={walletTxns}
          onClose={() => setWalletHistoryOpen(false)}
          onSelect={(t) => setWalletReceiptFor(t)}
        />
      )}
      {walletReceiptFor && <WalletReceiptSheet txn={walletReceiptFor} onClose={() => setWalletReceiptFor(null)} />}
      {tapMode === "choose" && (
        <RotaTapChooser
          onSend={() => setTapMode("send")}
          onReceive={() => setTapMode("receive")}
          onClose={() => setTapMode(null)}
        />
      )}
      {tapMode === "send" && wallet && (
        <TapSendSheet
          wallet={wallet}
          hasPin={settings.hasPin}
          hasBiometric={hasBiometricConfirm}
          myReceiveToken={settings.tapReceiveToken}
          onBack={() => setTapMode("choose")}
          onClose={() => setTapMode(null)}
          onClaimed={(newBalance) => refreshWalletBalance(newBalance)}
        />
      )}
      {tapMode === "receive" && (
        <TapReceiveSheet
          user={user}
          onBack={() => setTapMode("choose")}
          onClose={() => setTapMode(null)}
          onClaimed={(newBalance) => refreshWalletBalance(newBalance)}
        />
      )}
      {referralOpen && <ReferralSheet referralCode={settings.referralCode} onClose={() => setReferralOpen(false)} />}
      {billsMode && <BillsPurchaseSheet mode={billsMode} onClose={() => setBillsMode(null)} />}
    </div>
  );
}

// Money in and money out, grouped by day — so "what did I do today" is the
// first thing visible, with older days below rather than in a separate view.
function WalletHistorySheet({ transactions, onClose, onSelect }) {
  useBackClose(onClose);
  const groups = [];
  for (const t of transactions) {
    const day = (t.created_at || "").slice(0, 10);
    const existing = groups.find((g) => g.day === day);
    if (existing) existing.items.push(t);
    else groups.push({ day, items: [t] });
  }

  function dayLabel(day) {
    if (!day) return "Earlier";
    if (day === todayISO()) return "Today";
    if (day === isoOffset(-1)) return "Yesterday";
    return new Date(day + "T00:00:00").toLocaleDateString("en-NG", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  }

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 23 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 overflow-y-auto max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}`, maxHeight: "85vh" }}>
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            Transaction history
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>

        {transactions.length === 0 ? (
          <p className="text-sm text-center py-10" style={{ color: T.muted, fontFamily: FONT_BODY }}>
            Nothing here yet. Money you send or receive will show up here.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map((g) => {
              const inflow = g.items.filter((t) => t.type === "credit").reduce((s, t) => s + Number(t.amount || 0), 0);
              const outflow = g.items.filter((t) => t.type === "debit").reduce((s, t) => s + Number(t.amount || 0), 0);
              return (
                <div key={g.day || "unknown"}>
                  <div className="flex items-center justify-between mb-2">
                    <p style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-xs font-semibold">
                      {dayLabel(g.day)}
                    </p>
                    <p className="text-xs" style={{ fontFamily: FONT_MONO, color: T.muted }}>
                      {inflow > 0 && <span style={{ color: T.ok }}>+{naira(inflow)}</span>}
                      {inflow > 0 && outflow > 0 && " · "}
                      {outflow > 0 && <span>-{naira(outflow)}</span>}
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    {g.items.map((t) => (
                      <div
                        key={t.id}
                        onClick={() => onSelect?.(t)}
                        className="rounded-xl p-3 flex items-center justify-between cursor-pointer"
                        style={{ background: T.ink }}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className="rounded-full flex items-center justify-center flex-shrink-0"
                            style={{ width: 26, height: 26, background: t.type === "credit" ? T.ok : T.ink3 }}
                          >
                            {t.type === "credit" ? (
                              <ArrowDownLeft size={13} color={T.ink} />
                            ) : (
                              <ArrowUpRight size={13} color={T.muted} />
                            )}
                          </div>
                          <div className="min-w-0">
                            <p style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm truncate">
                              {t.description ||
                                (t.type === "credit"
                                  ? `From ${t.counterparty_name || "bank transfer"}`
                                  : `To ${t.counterparty_name || "recipient"}`)}
                            </p>
                            <p className="text-xs" style={{ color: T.muted, fontFamily: FONT_BODY }}>
                              {[t.counterparty_bank, t.created_at ? new Date(t.created_at).toLocaleTimeString("en-NG", { hour: "numeric", minute: "2-digit" }) : null]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                          </div>
                        </div>
                        <span
                          style={{ fontFamily: FONT_MONO, color: t.type === "credit" ? T.ok : T.paper }}
                          className="text-sm flex-shrink-0"
                        >
                          {t.type === "credit" ? "+" : "-"}
                          {naira(t.amount)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}


function TransactionHistorySheet({ payments, senderName, onClose }) {
  useBackClose(onClose);
  const [receiptFor, setReceiptFor] = useState(null);
  const paid = [...payments].filter((p) => p.status === "paid").sort((a, b) => (b.paid_at || b.date).localeCompare(a.paid_at || a.date));

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 21 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 overflow-y-auto max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}`, maxHeight: "80vh" }}>
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            Transaction History
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>

        {paid.length === 0 ? (
          <p className="text-sm text-center py-10" style={{ color: T.muted, fontFamily: FONT_BODY }}>
            No transactions yet. Paid Rotas will show up here.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {paid.map((p) => (
              <button
                key={p.id}
                onClick={() => setReceiptFor(p)}
                className="rounded-xl p-3 flex items-center justify-between text-left"
                style={{ background: T.ink }}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="rounded-full flex items-center justify-center flex-shrink-0" style={{ width: 26, height: 26, background: T.ok }}>
                    <Check size={13} color={T.ink} />
                  </div>
                  <div className="min-w-0">
                    <p style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm truncate">
                      {p.name}
                    </p>
                    <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
                      {p.paid_at ? new Date(p.paid_at).toLocaleDateString("en-NG") : p.date} · {p.category}
                    </p>
                  </div>
                </div>
                <span style={{ fontFamily: FONT_MONO, color: T.paper }} className="text-sm flex-shrink-0">
                  {naira(p.amount)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {receiptFor && <ReceiptSheet payment={receiptFor} senderName={senderName} onClose={() => setReceiptFor(null)} />}
    </div>
  );
}

/* ---------- Schedule tab ---------- */
function ScheduleTab({ payments, onAdd, onEdit, onMarkPaid, onDelete, onRetry, onFundSchedule, onRefresh, senderName, hasPin, hasBiometric, wallet }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [fundSheetOpen, setFundSheetOpen] = useState(false);
  const [receiptFor, setReceiptFor] = useState(null);
  const [detailFor, setDetailFor] = useState(null);
  const [detailEditIntent, setDetailEditIntent] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [payingOutId, setPayingOutId] = useState(null);
  const [executeFor, setExecuteFor] = useState(null);
  const [balanceHidden, setBalanceHidden] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const scheduleBalance = Number(wallet?.schedule_balance || 0);

  async function handleManualRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }

  // Execute always goes through ExecuteManualRotaSheet — same PIN/biometric
  // gate every other money-moving action in the app uses, whether or not a
  // recipient is already on file (a Manual Rota can be created as a pure
  // proposal with no recipient, collected + verified for the first time here).
  async function handleExecuteWithRecipient(payment, recipient) {
    setExecuteFor(null);
    setPayingOutId(payment.id);
    await onMarkPaid(payment.id, recipient);
    setPayingOutId(null);
  }
  const sorted = [...payments].sort((a, b) => a.date.localeCompare(b.date));
  const today = todayISO();
  const totalBudgeted = payments.reduce((s, p) => s + p.amount, 0);
  const totalPaid = payments.filter((p) => p.status === "paid").reduce((s, p) => s + p.amount, 0);
  const pct = totalBudgeted ? Math.min(100, Math.round((totalPaid / totalBudgeted) * 100)) : 0;
  const recentPaid = payments
    .filter((p) => p.status === "paid")
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 2);

  return (
    <div className="px-5 pb-4">
      <div className="flex items-center justify-between gap-2 mb-4">
        <button
          onClick={() => setSheetOpen(true)}
          className="rounded-full flex items-center gap-2 pl-3 pr-4 transition-transform active:scale-95 flex-shrink-0"
          style={{ height: 40, background: T.gold, boxShadow: `0 6px 16px -6px ${T.gold}` }}
        >
          <Plus size={18} color={T.ink2} />
          <span style={{ fontFamily: FONT_BODY, color: T.ink2 }} className="text-sm font-semibold">
            Schedule Payment
          </span>
        </button>
        <button
          onClick={() => setFundSheetOpen(true)}
          className="rounded-full flex items-center gap-2 pl-3 pr-4 transition-transform active:scale-95 flex-shrink-0"
          style={{ height: 40, background: T.ink2, border: `1px solid ${T.ink3}` }}
        >
          <Wallet size={16} color={T.gold} />
          <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm font-semibold">
            Add Funds
          </span>
        </button>
      </div>

      <div className="rota-sticky-card rounded-2xl p-4 mb-4" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <div className="flex items-center justify-between mb-1.5">
          <span className="flex items-center gap-1.5" style={{ fontFamily: FONT_BODY, color: T.muted }}>
            <span className="text-xs">Schedule Balance</span>
            <BalanceEyeToggle hidden={balanceHidden} onToggle={() => setBalanceHidden((v) => !v)} />
          </span>
          <button
            onClick={handleManualRefresh}
            disabled={refreshing}
            aria-label="Refresh"
            className="flex items-center justify-center flex-shrink-0"
            style={{ width: 26, height: 26, background: "none", border: "none" }}
          >
            <RotateCcw size={14} color={T.muted} className={refreshing ? "animate-spin" : ""} />
          </button>
        </div>
        <div style={{ fontFamily: FONT_MONO, color: T.paper }} className="text-2xl font-semibold mb-4">
          {balanceHidden ? "₦ • • • • • •" : naira(scheduleBalance)}
        </div>

        <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs mb-3">
          This month
        </p>
        <div className="flex items-end justify-between mb-3 gap-2">
          <div>
            <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs mb-0.5">
              Spent so far
            </p>
            <span style={{ fontFamily: FONT_MONO, color: T.ok }} className="text-lg font-semibold">
              {naira(totalPaid)}
            </span>
          </div>
          <div className="text-right">
            <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs mb-0.5">
              Total budget
            </p>
            <span style={{ fontFamily: FONT_MONO, color: T.paper }} className="text-lg font-semibold">
              {naira(totalBudgeted)}
            </span>
          </div>
        </div>
        <div className="rounded-full overflow-hidden mb-1" style={{ height: 8, background: T.ink3 }}>
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: T.gold }} />
        </div>
        <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
          {payments.length === 0
            ? "Tap Schedule Payment to add your first one and start tracking your budget"
            : `${pct}% paid out — ${naira(Math.max(0, totalBudgeted - totalPaid))} left to go`}
        </span>
      </div>

      {recentPaid.length > 0 && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
              Schedule activity
            </p>
            <button
              onClick={() => setHistoryOpen(true)}
              className="text-xs font-medium"
              style={{ color: T.gold, fontFamily: FONT_BODY }}
            >
              See all
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {recentPaid.map((p) => (
              <div
                key={p.id}
                onClick={() => setDetailFor(p)}
                className="rounded-xl p-3 flex items-center justify-between cursor-pointer"
                style={{ background: T.ink2 }}
              >
                <div className="flex items-center gap-2.5">
                  <div className="rounded-full flex items-center justify-center" style={{ width: 22, height: 22, background: T.ok }}>
                    <Check size={12} color={T.ink} />
                  </div>
                  <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm">
                    {p.name}
                  </span>
                </div>
                <span style={{ fontFamily: FONT_MONO, color: T.muted }} className="text-xs">
                  {naira(p.amount)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {sorted.length === 0 && (
        <p className="text-sm text-center py-10" style={{ color: T.muted, fontFamily: FONT_BODY }}>
          No payments scheduled yet. Tap + to add your first one.
        </p>
      )}
      <div className="relative pl-1">
        <div style={{ position: "absolute", left: 21, top: 6, bottom: 6, width: 2, background: T.ink3 }} />
        {sorted.map((p) => {
          const isToday = p.date === today;
          const isAutomatic = p.rota_type === "automatic";
          return (
            <div key={p.id} className="relative flex gap-3 mb-3">
              <div className="flex flex-col items-center pt-1" style={{ width: 42, flexShrink: 0 }}>
                <span style={{ fontFamily: FONT_MONO, color: T.paper, fontSize: 15, fontWeight: 600 }}>
                  {dayNum(p.date)}
                </span>
                <span style={{ fontFamily: FONT_BODY, color: T.muted, fontSize: 9 }}>{weekdayAbbr(p.date)}</span>
                <span
                  className="rounded-full mt-1.5"
                  style={{
                    width: 12,
                    height: 12,
                    background: p.status === "paid" ? T.gold : p.status === "failed" ? T.warn : "transparent",
                    border: `2px solid ${
                      p.status === "paid" ? T.gold : p.status === "failed" ? T.warn : isToday ? T.gold : T.ink3
                    }`,
                    zIndex: 1,
                  }}
                />
              </div>
              <div
                onClick={() => setDetailFor(p)}
                className="flex-1 rounded-2xl p-3.5 mt-0.5 cursor-pointer"
                style={{
                  background: isToday ? T.ink3 : T.ink2,
                  border: `1px solid ${p.status === "failed" ? T.warn : isToday ? T.gold : T.ink3}`,
                }}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm font-medium mb-0.5">
                      {p.name}
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <CategoryChip category={p.category} />
                      <span
                        className="text-[10px] font-semibold px-2 py-1 rounded-full"
                        style={{
                          fontFamily: FONT_BODY,
                          color: isAutomatic ? T.blue : T.gold,
                          background: isAutomatic
                            ? `linear-gradient(135deg, ${T.blue}40, ${T.blue}12)`
                            : `linear-gradient(135deg, ${T.gold}40, ${T.gold}12)`,
                          border: `1px solid ${isAutomatic ? T.blue : T.gold}50`,
                          backdropFilter: "blur(6px)",
                          WebkitBackdropFilter: "blur(6px)",
                          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.3), 0 1px 2px rgba(0,0,0,0.08)",
                        }}
                      >
                        {isAutomatic ? "Automatic Rota" : "Manual Rota"}
                      </span>
                      {p.status === "upcoming" && (
                        <span
                          className="text-[10px] flex items-center gap-1"
                          style={{ color: T.muted, fontFamily: FONT_BODY }}
                        >
                          <Clock size={9} /> {daysAway(p.date)}
                        </span>
                      )}
                    </div>
                    {p.recipient_account_name && (
                      <p className="text-xs mt-1" style={{ color: T.muted, fontFamily: FONT_BODY }}>
                        To {p.recipient_account_name} · {p.recipient_bank_name}
                      </p>
                    )}
                  </div>
                  <span style={{ fontFamily: FONT_MONO, color: T.paper }} className="text-sm">
                    {naira(p.amount)}
                  </span>
                </div>
                {p.status !== "paid" && p.charge_error && (
                  <p className="text-xs mt-1.5" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                    {p.charge_error}
                  </p>
                )}
                <div className="flex items-center justify-between mt-2.5">
                  {p.status === "paid" ? (
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1 text-xs" style={{ color: T.ok, fontFamily: FONT_BODY }}>
                        <Check size={12} /> Paid
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); setReceiptFor(p); }}
                        className="flex items-center gap-1 text-xs font-medium"
                        style={{ color: T.gold, fontFamily: FONT_BODY }}
                      >
                        <Receipt size={12} /> Receipt
                      </button>
                    </div>
                  ) : p.status === "failed" ? (
                    <button onClick={(e) => { e.stopPropagation(); onRetry(p.id); }} className="text-xs font-medium" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                      Payment failed — Retry
                    </button>
                  ) : isAutomatic ? (
                    <span className="flex items-center gap-1 text-xs" style={{ color: T.blue, fontFamily: FONT_BODY }}>
                      <Clock size={11} /> Runs automatically
                    </span>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); setExecuteFor(p); }}
                      disabled={payingOutId === p.id}
                      className="text-xs font-medium"
                      style={{ color: payingOutId === p.id ? T.muted : T.gold, fontFamily: FONT_BODY }}
                    >
                      {payingOutId === p.id ? "Executing…" : "Execute"}
                    </button>
                  )}
                  <div className="flex items-center gap-3">
                    {p.status === "upcoming" && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setDetailEditIntent(true); setDetailFor(p); }}
                      >
                        <Pencil size={14} color={T.muted} />
                      </button>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); onDelete(p.id); }}>
                      <Trash2 size={14} color={T.muted} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {sheetOpen && (
        <AddPaymentSheet
          onClose={() => setSheetOpen(false)}
          onSave={(p) => { onAdd(p); setSheetOpen(false); }}
          hasPin={hasPin}
          hasBiometric={hasBiometric}
          scheduleBalance={scheduleBalance}
          currentlyScheduled={payments.reduce((s, p) => s + p.amount, 0)}
        />
      )}
      {fundSheetOpen && (
        <FundScheduleSheet
          onClose={() => setFundSheetOpen(false)}
          onFund={onFundSchedule}
          hasPin={hasPin}
          hasBiometric={hasBiometric}
          homeBalance={Number(wallet?.balance || 0)}
        />
      )}
      {executeFor && (
        <ExecuteManualRotaSheet
          payment={executeFor}
          hasBiometric={hasBiometric}
          onClose={() => setExecuteFor(null)}
          onExecute={(recipient) => handleExecuteWithRecipient(executeFor, recipient)}
        />
      )}
      {receiptFor && <ReceiptSheet payment={receiptFor} senderName={senderName} onClose={() => setReceiptFor(null)} />}
      {historyOpen && (
        <TransactionHistorySheet payments={payments} senderName={senderName} onClose={() => setHistoryOpen(false)} />
      )}
      {detailFor && (
        <ScheduleDetailSheet
          payment={detailFor}
          startEditing={detailEditIntent}
          onClose={() => {
            setDetailFor(null);
            setDetailEditIntent(false);
          }}
          onSave={(updates) => {
            onEdit(detailFor.id, updates);
            setDetailFor(null);
            setDetailEditIntent(false);
          }}
        />
      )}
    </div>
  );
}

function FundScheduleSheet({ onClose, onFund, hasPin, hasBiometric, homeBalance }) {
  useBackClose(onClose);
  const [source, setSource] = useState("home");
  const [amount, setAmount] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const canSave = Number(amount) > 0 && hasPin && !submitting;

  async function submit() {
    setSubmitting(true);
    setError("");
    const result = await onFund(source, Number(amount));
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
  }

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 22 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 overflow-y-auto max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}`, maxHeight: "80vh" }}>
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            Fund Schedule Balance
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>
        <div className="flex flex-col gap-3">
          <div>
            <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
              Source
            </label>
            <div className="flex rounded-xl p-1" style={{ background: T.ink, border: `1px solid ${T.ink3}` }}>
              {[
                { key: "home", label: "Home balance" },
                { key: "card", label: "Linked card" },
              ].map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setSource(opt.key)}
                  className="flex-1 rounded-lg py-2 text-xs font-semibold transition-colors"
                  style={{
                    fontFamily: FONT_BODY,
                    background: source === opt.key ? T.gold : "transparent",
                    color: source === opt.key ? T.ink2 : T.muted,
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-xs mt-1.5" style={{ color: T.muted, fontFamily: FONT_BODY }}>
              {source === "home"
                ? `Moves money you already have on Home into Schedule Balance — instant, no card involved. Home balance: ${naira(homeBalance)}.`
                : "Charges your linked card directly into Schedule Balance — Home's balance isn't touched."}
            </p>
          </div>
          <div>
            <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
              Amount (₦)
            </label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              className="w-full rounded-xl px-3 py-2.5 text-sm"
              style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_MONO }}
            />
          </div>
          {!hasPin && (
            <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
              Set a transaction PIN in Profile → Settings before funding Schedule Balance.
            </p>
          )}
          {error && (
            <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
              {error}
            </p>
          )}
          <button
            disabled={!canSave}
            onClick={() => setConfirming(true)}
            className="w-full rounded-2xl py-3 font-semibold text-sm mt-1 transition-transform active:scale-95"
            style={{ background: canSave ? T.gold : T.ink3, color: canSave ? T.ink2 : T.muted, fontFamily: FONT_BODY }}
          >
            {submitting ? "Funding…" : "Fund Schedule Balance"}
          </button>
        </div>
      </div>
      {confirming && (
        <ConfirmSheet
          hasBiometric={hasBiometric}
          onClose={() => setConfirming(false)}
          onConfirmed={() => {
            setConfirming(false);
            submit();
          }}
        />
      )}
    </div>
  );
}

// Manual Rotas can be created as a pure proposal with no recipient — this is
// where one gets collected and verified for the first time (or re-shown,
// already filled in, if one's already on file), gated behind the same PIN
// confirmation every other money-moving action in the app uses before the
// real Schedule Balance payout actually fires.
function ExecuteManualRotaSheet({ payment, hasBiometric, onClose, onExecute }) {
  useBackClose(onClose);
  const [banks, setBanks] = useState(cachedBanks || []);
  const [banksLoading, setBanksLoading] = useState(!cachedBanks);
  const [banksError, setBanksError] = useState("");
  const [bankCode, setBankCode] = useState(payment.recipient_bank_code || "");
  const [accountNumber, setAccountNumber] = useState(payment.recipient_account_number || "");
  const [resolvedName, setResolvedName] = useState(payment.recipient_account_name || "");
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [detectMatches, setDetectMatches] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const autoDetectedKeyRef = useRef(
    payment.recipient_account_number ? `${payment.recipient_account_number}:${payment.recipient_bank_code}` : ""
  );

  useEffect(() => {
    if (cachedBanks) return;
    let alive = true;
    supabase.functions.invoke("list-banks", { body: {} }).then(({ data, error }) => {
      if (!alive) return;
      if (error || !data?.banks) {
        setBanksError("Couldn't load the bank list.");
      } else {
        cachedBanks = data.banks;
        setBanks(data.banks);
      }
      setBanksLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setResolveError("");
    setDetectMatches([]);
    if (accountNumber.length !== 10) {
      setResolvedName("");
      return;
    }
    if (bankCode) {
      const key = `${accountNumber}:${bankCode}`;
      if (autoDetectedKeyRef.current === key) return;
      setResolvedName("");
      setResolving(true);
      const handle = setTimeout(async () => {
        const { data, error } = await supabase.functions.invoke("resolve-account", {
          body: { account_number: accountNumber, bank_code: bankCode },
        });
        if (error || !data?.account_name) {
          setResolveError((data && data.error) || "Couldn't verify that account.");
        } else {
          setResolvedName(data.account_name);
        }
        setResolving(false);
      }, 500);
      return () => clearTimeout(handle);
    }
    setResolvedName("");
    setDetecting(true);
    supabase.functions.invoke("detect-bank", { body: { account_number: accountNumber } }).then(({ data, error }) => {
      setDetecting(false);
      if (error || !data?.matches || data.matches.length === 0) return;
      if (data.matches.length === 1) {
        const m = data.matches[0];
        autoDetectedKeyRef.current = `${accountNumber}:${m.bank_code}`;
        setBankCode(m.bank_code);
        setResolvedName(m.account_name);
      } else {
        setDetectMatches(data.matches);
      }
    });
  }, [accountNumber, bankCode]);

  const bankName = banks.find((b) => b.code === bankCode)?.name || payment.recipient_bank_name || "";
  const recipientReady = bankCode && accountNumber.length === 10 && resolvedName;

  function pickBank(bank) {
    autoDetectedKeyRef.current = "";
    setBankCode(bank.code);
    setPickerOpen(false);
  }

  function pickDetectedMatch(match) {
    autoDetectedKeyRef.current = `${accountNumber}:${match.bank_code}`;
    setBankCode(match.bank_code);
    setResolvedName(match.account_name);
    setDetectMatches([]);
  }

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 24 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 overflow-y-auto max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}`, maxHeight: "85vh" }}>
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            Execute — {payment.name}
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>
        <p className="text-xs mb-3" style={{ color: T.muted, fontFamily: FONT_BODY }}>
          Pays {naira(payment.amount)} from your Schedule Balance to the recipient below.
        </p>
        <div className="flex flex-col gap-3">
          <div>
            <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
              Account number
            </label>
            <input
              value={accountNumber}
              onChange={(e) => {
                setAccountNumber(e.target.value.replace(/\D/g, "").slice(0, 10));
                autoDetectedKeyRef.current = "";
              }}
              placeholder="10-digit account number"
              inputMode="numeric"
              className="w-full rounded-xl px-3 py-2.5 text-sm"
              style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_MONO }}
            />
          </div>

          {detecting && (
            <p className="text-xs flex items-center gap-1.5" style={{ color: T.muted, fontFamily: FONT_BODY }}>
              <Loader2 size={12} className="animate-spin" /> Detecting bank...
            </p>
          )}

          {detectMatches.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs" style={{ color: T.muted, fontFamily: FONT_BODY }}>
                Found more than one match — which is it?
              </p>
              {detectMatches.map((m) => (
                <button
                  key={m.bank_code}
                  onClick={() => pickDetectedMatch(m)}
                  className="text-left rounded-xl px-3 py-2 text-xs flex items-center gap-2"
                  style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
                >
                  <BankMonogram name={m.bank_name} size={20} />
                  {m.bank_name} — {m.account_name}
                </button>
              ))}
            </div>
          )}

          <div>
            <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
              Bank
            </label>
            <button
              onClick={() => setPickerOpen(true)}
              disabled={banksLoading}
              className="w-full rounded-xl px-3 py-2.5 text-sm flex items-center justify-between"
              style={{ background: T.ink, border: `1px solid ${T.ink3}`, fontFamily: FONT_BODY }}
            >
              <span className="flex items-center gap-2 min-w-0">
                {bankName && <BankMonogram name={bankName} />}
                <span className="truncate" style={{ color: bankName ? T.paper : T.muted }}>
                  {bankName || (banksLoading ? "Loading banks..." : "Tap to select bank")}
                </span>
              </span>
              <ChevronDown size={14} color={T.muted} style={{ flexShrink: 0 }} />
            </button>
            {banksError && (
              <p className="text-xs mt-1" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                {banksError}
              </p>
            )}
          </div>

          {resolving && (
            <p className="text-xs flex items-center gap-1.5" style={{ color: T.muted, fontFamily: FONT_BODY }}>
              <Loader2 size={12} className="animate-spin" /> Verifying account...
            </p>
          )}
          {resolvedName && (
            <p className="text-xs flex items-center gap-1.5" style={{ color: T.ok, fontFamily: FONT_BODY }}>
              <Check size={12} /> {resolvedName}
            </p>
          )}
          {resolveError && (
            <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
              {resolveError}
            </p>
          )}

          <button
            disabled={!recipientReady}
            onClick={() => setConfirming(true)}
            className="w-full rounded-2xl py-3 font-semibold text-sm mt-1 transition-transform active:scale-95"
            style={{ background: recipientReady ? T.gold : T.ink3, color: recipientReady ? T.ink2 : T.muted, fontFamily: FONT_BODY }}
          >
            {recipientReady ? "Confirm & Execute" : "Verify recipient to continue"}
          </button>
        </div>
      </div>
      {pickerOpen && (
        <BankPicker banks={banks} banksLoading={banksLoading} value={bankCode} onSelect={pickBank} onClose={() => setPickerOpen(false)} />
      )}
      {confirming && (
        <ConfirmSheet
          hasBiometric={hasBiometric}
          onClose={() => setConfirming(false)}
          onConfirmed={() => {
            setConfirming(false);
            onExecute({
              recipient_bank_code: bankCode,
              recipient_bank_name: bankName,
              recipient_account_number: accountNumber,
              recipient_account_name: resolvedName,
            });
          }}
        />
      )}
    </div>
  );
}

let cachedBanks = null;

function ScheduleDetailSheet({ payment, onClose, onSave, startEditing = false }) {
  useBackClose(onClose);
  const canEdit = payment.status === "upcoming";
  const [editing, setEditing] = useState(startEditing);
  const [name, setName] = useState(payment.name);
  const [amount, setAmount] = useState(String(payment.amount));
  const [date, setDate] = useState(payment.date);
  const [scheduledTime, setScheduledTime] = useState((payment.scheduled_time || "09:00:00").slice(0, 5));
  const [category, setCategory] = useState(payment.category);

  function save() {
    onSave({
      name: name.trim() || payment.name,
      amount: Number(amount) > 0 ? Number(amount) : payment.amount,
      date,
      scheduled_time: scheduledTime ? `${scheduledTime}:00` : payment.scheduled_time,
      category,
    });
  }

  const isAutomatic = payment.rota_type === "automatic";
  const canSave = name.trim().length > 0 && Number(amount) > 0 && date;

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 22 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 overflow-y-auto max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}`, maxHeight: "70vh" }}>
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            {editing ? "Edit Rota" : "Rota details"}
          </h3>
          <div className="flex items-center gap-3">
            {canEdit && !editing && (
              <button onClick={() => setEditing(true)}>
                <Pencil size={16} color={T.muted} />
              </button>
            )}
            <button onClick={onClose}>
              <X size={18} color={T.muted} />
            </button>
          </div>
        </div>

        {editing ? (
          <div className="flex flex-col gap-3">
            <div>
              <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
                Name
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-xl px-3 py-2.5 text-sm"
                style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
              />
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
                  Amount (₦)
                </label>
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full rounded-xl px-3 py-2.5 text-sm"
                  style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_MONO }}
                />
              </div>
              <div className="flex-1">
                <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
                  Date
                </label>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="w-full rounded-xl px-3 py-2.5 text-sm"
                  style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
                />
              </div>
              <div className="flex-1">
                <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
                  Time
                </label>
                <input
                  type="time"
                  value={scheduledTime}
                  onChange={(e) => setScheduledTime(e.target.value)}
                  className="w-full rounded-xl px-3 py-2.5 text-sm"
                  style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
                />
              </div>
            </div>
            <div>
              <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
                Category
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full rounded-xl px-3 py-2.5 text-sm"
                style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            {isAutomatic && payment.recipient_account_name && (
              <p className="text-xs" style={{ color: T.muted, fontFamily: FONT_BODY }}>
                Recipient ({payment.recipient_account_name} · {payment.recipient_bank_name}) can't be changed here —
                delete and recreate the Rota to use a different recipient.
              </p>
            )}
            <div className="flex gap-2 mt-1">
              <button
                onClick={() => setEditing(false)}
                className="flex-1 rounded-2xl py-3 font-semibold text-sm"
                style={{ background: T.ink3, color: T.muted, fontFamily: FONT_BODY }}
              >
                Cancel
              </button>
              <button
                disabled={!canSave}
                onClick={save}
                className="flex-1 rounded-2xl py-3 font-semibold text-sm transition-transform active:scale-95"
                style={{ background: canSave ? T.gold : T.ink3, color: canSave ? T.ink2 : T.muted, fontFamily: FONT_BODY }}
              >
                Save changes
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <ReceiptRow label="Name" value={payment.name} />
            <ReceiptRow label="Amount" value={naira(payment.amount)} mono />
            <ReceiptRow label="Date" value={payment.date} />
            <ReceiptRow label="Category" value={payment.category} />
            <ReceiptRow label="Type" value={isAutomatic ? "Automatic Rota" : "Manual Rota"} />
            <ReceiptRow
              label="Status"
              value={payment.status === "paid" ? "Paid" : payment.status === "failed" ? "Failed" : "Upcoming"}
            />
            {payment.recipient_account_name && (
              <>
                <ReceiptRow label="Recipient" value={payment.recipient_account_name} />
                <ReceiptRow
                  label="Account"
                  value={`${payment.recipient_account_number} · ${payment.recipient_bank_name || "—"}`}
                  mono
                />
              </>
            )}
            {payment.status === "failed" && payment.charge_error && (
              <p className="text-xs mt-1" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                {payment.charge_error}
              </p>
            )}
            {!canEdit && (
              <p className="text-xs mt-2" style={{ color: T.muted, fontFamily: FONT_BODY }}>
                This Rota has already {payment.status === "paid" ? "been paid" : "run"} and can no longer be edited.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Colored monogram chips for banks — a visual identity cue like OPay/PalmPay/Kuda
// use in their own apps, without reproducing any bank's actual trademarked logo
// artwork (which Rota isn't licensed to use).
const BANK_BRAND_COLORS = {
  opay: "#1FBB53",
  palmpay: "#6C2EB5",
  moniepoint: "#1447E6",
  kuda: "#4B0D64",
  "access bank": "#F9A11B",
  "guaranty trust": "#E4592B",
  gtbank: "#E4592B",
  zenith: "#EF3E36",
  "united bank for africa": "#E4032E",
  "first bank": "#00447C",
  fidelity: "#00563F",
  "union bank": "#00A651",
  sterling: "#A6192E",
  stanbic: "#0033A0",
  ecobank: "#00539F",
  fcmb: "#4B2E83",
  wema: "#7B2D8E",
  polaris: "#582C83",
  keystone: "#00A99D",
  providus: "#003DA5",
  jaiz: "#00A651",
  heritage: "#6E2C91",
  carbon: "#000000",
  paga: "#EF4136",
  vfd: "#0A2E5C",
  sparkle: "#F5A623",
  titan: "#0F4C81",
};
function bankVisual(name) {
  const key = Object.keys(BANK_BRAND_COLORS).find((k) => name.toLowerCase().includes(k));
  const color = key ? BANK_BRAND_COLORS[key] : ["#8B5CF6", "#4C8EFF", "#1FC28B", "#FF6B5B", "#FFC93C"][name.length % 5];
  const words = name.replace(/\(.*\)/, "").trim().split(/\s+/);
  const initials = words.length > 1 ? (words[0][0] + words[1][0]) : name.slice(0, 2);
  return { color, initials: initials.toUpperCase() };
}
function BankMonogram({ name, size = 22 }) {
  const { color, initials } = bankVisual(name);
  return (
    <span
      className="rounded-full flex items-center justify-center flex-shrink-0"
      style={{ width: size, height: size, background: color, color: "#FFF", fontSize: size * 0.38, fontWeight: 700, fontFamily: FONT_BODY }}
    >
      {initials}
    </span>
  );
}

function AddPaymentSheet({ onClose, onSave, hasPin, hasBiometric, scheduleBalance, currentlyScheduled }) {
  useBackClose(onClose);
  const [rotaType, setRotaType] = useState("manual");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayISO());
  const [scheduledTime, setScheduledTime] = useState("09:00");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [confirming, setConfirming] = useState(false);

  const [banks, setBanks] = useState(cachedBanks || []);
  const [banksLoading, setBanksLoading] = useState(!cachedBanks);
  const [banksError, setBanksError] = useState("");
  const [bankCode, setBankCode] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [resolvedName, setResolvedName] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [detectMatches, setDetectMatches] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const autoDetectedKeyRef = useRef("");

  useEffect(() => {
    if (cachedBanks) return;
    let alive = true;
    supabase.functions.invoke("list-banks", { body: {} }).then(({ data, error }) => {
      if (!alive) return;
      if (error || !data?.banks) {
        setBanksError("Couldn't load the bank list. You can still save without recipient details.");
      } else {
        cachedBanks = data.banks;
        setBanks(data.banks);
      }
      setBanksLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Once the account number is complete: if a bank is already chosen, verify
  // against it. Otherwise, try to auto-detect the bank (like OPay/PalmPay do)
  // by checking the number against common banks and fintechs.
  useEffect(() => {
    setResolveError("");
    setDetectMatches([]);
    if (accountNumber.length !== 10) {
      setResolvedName("");
      return;
    }

    if (bankCode) {
      const key = `${accountNumber}:${bankCode}`;
      if (autoDetectedKeyRef.current === key) return; // already resolved via auto-detect
      setResolvedName("");
      setResolving(true);
      const handle = setTimeout(async () => {
        const { data, error } = await supabase.functions.invoke("resolve-account", {
          body: { account_number: accountNumber, bank_code: bankCode },
        });
        if (error || !data?.account_name) {
          setResolveError((data && data.error) || "Couldn't verify that account.");
        } else {
          setResolvedName(data.account_name);
        }
        setResolving(false);
      }, 500);
      return () => clearTimeout(handle);
    }

    setResolvedName("");
    setDetecting(true);
    supabase.functions.invoke("detect-bank", { body: { account_number: accountNumber } }).then(({ data, error }) => {
      setDetecting(false);
      if (error || !data?.matches || data.matches.length === 0) return;
      if (data.matches.length === 1) {
        const m = data.matches[0];
        autoDetectedKeyRef.current = `${accountNumber}:${m.bank_code}`;
        setBankCode(m.bank_code);
        setResolvedName(m.account_name);
      } else {
        setDetectMatches(data.matches);
      }
    });
  }, [accountNumber, bankCode]);

  const bankName = banks.find((b) => b.code === bankCode)?.name || "";
  const recipientReady = bankCode && accountNumber.length === 10 && resolvedName;
  const canSave = name.trim().length > 0 && Number(amount) > 0 && date && (rotaType === "manual" || recipientReady) && hasPin;
  const projectedTotal = (currentlyScheduled || 0) + (Number(amount) || 0);
  const wouldExceedBalance = scheduleBalance > 0 && projectedTotal > scheduleBalance;

  function pickBank(bank) {
    autoDetectedKeyRef.current = "";
    setBankCode(bank.code);
    setPickerOpen(false);
  }

  function pickDetectedMatch(match) {
    autoDetectedKeyRef.current = `${accountNumber}:${match.bank_code}`;
    setBankCode(match.bank_code);
    setResolvedName(match.account_name);
    setDetectMatches([]);
  }

  function save() {
    onSave({
      id: uid(),
      name: name.trim(),
      amount: Number(amount),
      date,
      scheduled_time: scheduledTime ? `${scheduledTime}:00` : "09:00:00",
      category,
      status: "upcoming",
      rota_type: rotaType,
      recipient_bank_code: bankCode || null,
      recipient_bank_name: bankName || null,
      recipient_account_number: accountNumber || null,
      recipient_account_name: resolvedName || null,
    });
  }

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 20 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 overflow-y-auto max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}`, maxHeight: "85vh" }}>
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            Schedule payment
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>
        <div className="flex flex-col gap-3">
          <div>
            <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
              Rota type
            </label>
            <div className="flex rounded-xl p-1" style={{ background: T.ink, border: `1px solid ${T.ink3}` }}>
              {[
                { key: "automatic", label: "Automatic Rota" },
                { key: "manual", label: "Manual Rota" },
              ].map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setRotaType(opt.key)}
                  className="flex-1 rounded-lg py-2 text-xs font-semibold transition-colors"
                  style={{
                    fontFamily: FONT_BODY,
                    background: rotaType === opt.key ? T.gold : "transparent",
                    color: rotaType === opt.key ? T.ink2 : T.muted,
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-xs mt-1.5" style={{ color: T.muted, fontFamily: FONT_BODY }}>
              {rotaType === "automatic"
                ? "Rota verifies the recipient now and pays them from your Schedule Balance automatically on the due date."
                : "Add the recipient whenever you're ready — verify and pay from your Schedule Balance then."}
            </p>
          </div>

          <div>
            <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. School fees"
              className="w-full rounded-xl px-3 py-2.5 text-sm"
              style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
            />
          </div>
          <div>
            <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
              Amount (₦)
            </label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              className="w-full rounded-xl px-3 py-2.5 text-sm"
              style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_MONO }}
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
                Date
              </label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full rounded-xl px-3 py-2.5 text-sm"
                style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
              />
            </div>
            <div className="flex-1">
              <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
                Time
              </label>
              <input
                type="time"
                value={scheduledTime}
                onChange={(e) => setScheduledTime(e.target.value)}
                className="w-full rounded-xl px-3 py-2.5 text-sm"
                style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
              />
            </div>
          </div>
          <div>
            <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
              Category
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-xl px-3 py-2.5 text-sm"
              style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="pt-1" style={{ borderTop: `1px solid ${T.ink3}` }}>
            <p style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm font-medium mt-3 mb-2">
              Recipient {rotaType === "manual" && <span style={{ color: T.muted, fontWeight: 400 }}>(optional)</span>}
            </p>
            <div className="flex flex-col gap-3">
              <div>
                <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
                  Account number
                </label>
                <input
                  value={accountNumber}
                  onChange={(e) => {
                    setAccountNumber(e.target.value.replace(/\D/g, "").slice(0, 10));
                    autoDetectedKeyRef.current = "";
                  }}
                  placeholder="10-digit account number"
                  inputMode="numeric"
                  className="w-full rounded-xl px-3 py-2.5 text-sm"
                  style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_MONO }}
                />
              </div>

              {detecting && (
                <p className="text-xs flex items-center gap-1.5" style={{ color: T.muted, fontFamily: FONT_BODY }}>
                  <Loader2 size={12} className="animate-spin" /> Detecting bank...
                </p>
              )}

              {detectMatches.length > 1 && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs" style={{ color: T.muted, fontFamily: FONT_BODY }}>
                    Found more than one match — which is it?
                  </p>
                  {detectMatches.map((m) => (
                    <button
                      key={m.bank_code}
                      onClick={() => pickDetectedMatch(m)}
                      className="text-left rounded-xl px-3 py-2 text-xs flex items-center gap-2"
                      style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
                    >
                      <BankMonogram name={m.bank_name} size={20} />
                      {m.bank_name} — {m.account_name}
                    </button>
                  ))}
                </div>
              )}

              <div>
                <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
                  Bank
                </label>
                <button
                  onClick={() => setPickerOpen(true)}
                  disabled={banksLoading}
                  className="w-full rounded-xl px-3 py-2.5 text-sm flex items-center justify-between"
                  style={{ background: T.ink, border: `1px solid ${T.ink3}`, fontFamily: FONT_BODY }}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    {bankName && <BankMonogram name={bankName} />}
                    <span className="truncate" style={{ color: bankName ? T.paper : T.muted }}>
                      {bankName || (banksLoading ? "Loading banks..." : "Tap to select bank")}
                    </span>
                  </span>
                  <ChevronDown size={14} color={T.muted} style={{ flexShrink: 0 }} />
                </button>
                {banksError && (
                  <p className="text-xs mt-1" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                    {banksError}
                  </p>
                )}
              </div>

              {resolving && (
                <p className="text-xs flex items-center gap-1.5" style={{ color: T.muted, fontFamily: FONT_BODY }}>
                  <Loader2 size={12} className="animate-spin" /> Verifying account...
                </p>
              )}
              {resolvedName && (
                <p className="text-xs flex items-center gap-1.5" style={{ color: T.ok, fontFamily: FONT_BODY }}>
                  <Check size={12} /> {resolvedName}
                </p>
              )}
              {resolveError && (
                <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                  {resolveError}
                </p>
              )}
              {!resolving && !resolvedName && !resolveError && !detecting && accountNumber.length === 10 && !bankCode && detectMatches.length === 0 && (
                <p className="text-xs" style={{ color: T.muted, fontFamily: FONT_BODY }}>
                  Couldn't auto-detect the bank — select it above to verify manually.
                </p>
              )}
            </div>
          </div>

          {!hasPin && (
            <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
              Set a transaction PIN in Profile → Settings before scheduling a Rota.
            </p>
          )}
          {wouldExceedBalance && (
            <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
              This would put your scheduled Rotas {naira(projectedTotal - scheduleBalance)} over your Schedule Balance.
              You can still save it — just a heads up.
            </p>
          )}
          <button
            disabled={!canSave}
            onClick={() => setConfirming(true)}
            className="w-full rounded-2xl py-3 font-semibold text-sm mt-1 transition-transform active:scale-95"
            style={{ background: canSave ? T.gold : T.ink3, color: canSave ? T.ink2 : T.muted, fontFamily: FONT_BODY }}
          >
            {rotaType === "automatic" && !recipientReady ? "Verify recipient to continue" : "Save payment"}
          </button>
        </div>
      </div>
      {pickerOpen && (
        <BankPicker banks={banks} banksLoading={banksLoading} value={bankCode} onSelect={pickBank} onClose={() => setPickerOpen(false)} />
      )}
      {confirming && (
        <ConfirmSheet
          hasBiometric={hasBiometric}
          onClose={() => setConfirming(false)}
          onConfirmed={() => {
            setConfirming(false);
            save();
          }}
        />
      )}
    </div>
  );
}

function BankPicker({ banks, banksLoading, value, onSelect, onClose }) {
  useBackClose(onClose);
  const [query, setQuery] = useState("");
  const filtered = query.trim() ? banks.filter((b) => b.name.toLowerCase().includes(query.trim().toLowerCase())) : banks;

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 30 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 flex flex-col max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}`, maxHeight: "75vh" }}>
        <div className="flex items-center justify-between mb-3">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            Select bank
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>
        <div className="relative mb-3 flex-shrink-0">
          <Search size={15} color={T.muted} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)" }} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search banks..."
            className="w-full rounded-xl pl-9 pr-3 py-2.5 text-sm"
            style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
          />
        </div>
        <div className="overflow-y-auto flex flex-col gap-1">
          {banksLoading && (
            <p className="text-xs text-center py-4" style={{ color: T.muted, fontFamily: FONT_BODY }}>
              Loading banks...
            </p>
          )}
          {!banksLoading && filtered.length === 0 && (
            <p className="text-xs text-center py-4" style={{ color: T.muted, fontFamily: FONT_BODY }}>
              No banks match "{query}"
            </p>
          )}
          {filtered.map((b) => (
            <button
              key={b.code}
              onClick={() => onSelect(b)}
              className="text-left rounded-xl px-3 py-2.5 text-sm flex items-center gap-2.5"
              style={{
                fontFamily: FONT_BODY,
                color: T.paper,
                background: value === b.code ? T.ink3 : "transparent",
              }}
            >
              <BankMonogram name={b.name} />
              {b.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- Receipt sheet ---------- */
// Shared by ReceiptSheet and WalletReceiptSheet — draws a branded receipt
// card to an offscreen canvas and returns it as a PNG blob, styled after
// OPay/PalmPay/Moniepoint's receipts: a colored header banner, a white card
// floating over it with a status pill, a big colored amount, a prominent
// two-line counterparty block, then plain detail rows.
async function buildBrandedReceiptImage({ statusLabel, amountText, amountColor, primaryLabel, primaryName, primarySubline, metaRows }) {
  await document.fonts.ready.catch(() => {});
  const W = 720;
  const HEADER_H = 152;
  const CARD_TOP = 112;
  const rowH = 52;
  const primaryBlockH = primarySubline ? 92 : 70;
  const H = CARD_TOP + 210 + primaryBlockH + metaRows.length * rowH + 90;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  function roundedRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Page background
  ctx.fillStyle = "#EDE4D3";
  ctx.fillRect(0, 0, W, H);

  // Colored header banner with the Rota mark
  ctx.fillStyle = "#8B5CF6";
  ctx.fillRect(0, 0, W, HEADER_H);
  const logo = await loadLogoImage();
  if (logo) {
    ctx.drawImage(logo, 48, HEADER_H / 2 - 30, 60, 60);
    ctx.fillStyle = "#FFFFFF";
    ctx.font = "700 42px Fredoka, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText("rota", 48 + 60 + 16, HEADER_H / 2 + 2);
  } else {
    ctx.fillStyle = "#FFFFFF";
    ctx.font = "700 42px Fredoka, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText("rota", 48, HEADER_H / 2 + 2);
  }
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = "600 15px Nunito, sans-serif";
  ctx.fillText("Transaction Receipt", W - 48, HEADER_H / 2 + 2);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // White card floating over the banner
  ctx.fillStyle = "#FFFFFF";
  roundedRect(32, CARD_TOP, W - 64, H - CARD_TOP - 32, 24);
  ctx.fill();

  let y = CARD_TOP + 56;

  // Status pill
  const pillText = statusLabel;
  ctx.font = "700 14px Nunito, sans-serif";
  const pillTextW = ctx.measureText(pillText.toUpperCase()).width;
  const pillW = pillTextW + 46;
  ctx.fillStyle = "rgba(31,194,139,0.14)";
  roundedRect(48, y - 24, pillW, 34, 17);
  ctx.fill();
  ctx.fillStyle = "#1FC28B";
  ctx.beginPath();
  ctx.arc(48 + 17, y - 7, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(48 + 14, y - 7);
  ctx.lineTo(48 + 16.5, y - 4.5);
  ctx.lineTo(48 + 21, y - 10);
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.fillStyle = "#1FC28B";
  ctx.font = "700 14px Nunito, sans-serif";
  ctx.fillText(pillText.toUpperCase(), 48 + 32, y - 2);

  y += 68;
  ctx.fillStyle = amountColor;
  ctx.font = "700 52px 'IBM Plex Mono', monospace";
  ctx.fillText(amountText, 48, y);

  y += 40;
  ctx.strokeStyle = "#EDE4D3";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(48, y);
  ctx.lineTo(W - 48, y);
  ctx.stroke();

  // Primary counterparty block — bold name, muted detail line beneath
  y += 40;
  ctx.fillStyle = "#9C927F";
  ctx.font = "600 13px Nunito, sans-serif";
  ctx.fillText(primaryLabel.toUpperCase(), 48, y);
  y += 28;
  ctx.fillStyle = "#2E2A22";
  ctx.font = "700 22px Nunito, sans-serif";
  ctx.fillText(primaryName, 48, y);
  if (primarySubline) {
    y += 26;
    ctx.fillStyle = "#9C927F";
    ctx.font = "500 15px Nunito, sans-serif";
    ctx.fillText(primarySubline, 48, y);
  }

  y += 34;
  ctx.strokeStyle = "#EDE4D3";
  ctx.beginPath();
  ctx.moveTo(48, y);
  ctx.lineTo(W - 48, y);
  ctx.stroke();

  y += 44;
  for (const [label, value] of metaRows) {
    ctx.textAlign = "left";
    ctx.fillStyle = "#9C927F";
    ctx.font = "500 16px Nunito, sans-serif";
    ctx.fillText(label, 48, y);

    ctx.textAlign = "right";
    ctx.fillStyle = "#2E2A22";
    ctx.font = "600 16px Nunito, sans-serif";
    ctx.fillText(String(value), W - 48, y);
    y += rowH;
  }
  ctx.textAlign = "left";

  y += 4;
  ctx.strokeStyle = "#EDE4D3";
  ctx.beginPath();
  ctx.moveTo(48, y);
  ctx.lineTo(W - 48, y);
  ctx.stroke();

  y += 38;
  ctx.fillStyle = "#9C927F";
  ctx.font = "italic 14px Nunito, sans-serif";
  ctx.fillText("Money, on schedule. — Rota", 48, y);

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png", 0.95));
}

// The full receipt sheet UI, shared by ReceiptSheet and WalletReceiptSheet —
// both just compute the props below from their own data shape (a scheduled
// payment vs. a wallet transaction) and render this.
function ReceiptCardSheet({ statusLabel, statusIcon, amountText, amountColor, primaryLabel, primaryName, primarySubline, metaRows, copyLines, fileName, onClose }) {
  useBackClose(onClose);
  const [shareState, setShareState] = useState("idle"); // idle | generating | copied
  const [imgError, setImgError] = useState("");

  async function shareImage() {
    setShareState("generating");
    setImgError("");
    try {
      const blob = await buildBrandedReceiptImage({ statusLabel, amountText, amountColor, primaryLabel, primaryName, primarySubline, metaRows });
      if (!blob) throw new Error("Could not render image");

      if (IS_NATIVE) {
        // The Web Share API (navigator.share/canShare) isn't implemented in
        // Android's WebView the way it is in a real browser, so this was
        // silently falling through to a download-link click that Capacitor's
        // WebView also doesn't handle — nothing visibly happened either way.
        // Writing the file natively and handing it to the native Share
        // sheet is the reliable path.
        const base64 = await blobToBase64(blob);
        const written = await Filesystem.writeFile({ path: fileName, data: base64, directory: Directory.Cache });
        await Share.share({ title: "Rota receipt", url: written.uri });
      } else if (navigator.canShare && navigator.canShare({ files: [new File([blob], fileName, { type: "image/png" })] })) {
        await navigator.share({ files: [new File([blob], fileName, { type: "image/png" })], title: "Rota receipt" });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      }
    } catch (e) {
      if (e?.name !== "AbortError") setImgError("Couldn't generate the receipt image. Try again.");
    } finally {
      setShareState("idle");
    }
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(copyLines.join("\n"));
      setShareState("copied");
      setTimeout(() => setShareState("idle"), 1500);
    } catch {
      // clipboard unavailable — no-op
    }
  }

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 25 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl max-w-lg mx-auto w-full overflow-hidden" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <div className="relative px-5 pt-11 pb-9" style={{ background: T.gold }}>
          <button onClick={onClose} className="absolute top-4 right-4">
            <X size={18} color="#FFFFFF" style={{ opacity: 0.85 }} />
          </button>
          <div className="flex items-center gap-3">
            <RotaMark size={44} />
            <span style={{ fontFamily: FONT_DISPLAY, color: "#FFFFFF" }} className="text-2xl font-semibold">
              rota
            </span>
          </div>
        </div>

        <div className="relative px-5 pb-5" style={{ marginTop: -22 }}>
          <div className="rounded-3xl p-5" style={{ background: T.ink2, border: `1px solid ${T.ink3}`, boxShadow: "0 -8px 24px -12px rgba(0,0,0,0.15)" }}>
            <div
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 mb-4"
              style={{ background: `${T.ok}24` }}
            >
              {statusIcon}
              <span style={{ fontFamily: FONT_BODY, color: T.ok }} className="text-xs font-bold uppercase tracking-wide">
                {statusLabel}
              </span>
            </div>

            <div style={{ fontFamily: FONT_MONO, color: amountColor }} className="text-4xl font-bold mb-5">
              {amountText}
            </div>

            <div className="h-px mb-4" style={{ background: T.ink3 }} />

            <div className="mb-4">
              <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-[11px] font-semibold uppercase tracking-wide mb-1.5">
                {primaryLabel}
              </p>
              <p style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-lg font-bold leading-tight">
                {primaryName}
              </p>
              {primarySubline && (
                <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-sm mt-0.5">
                  {primarySubline}
                </p>
              )}
            </div>

            <div className="h-px mb-4" style={{ background: T.ink3 }} />

            <div className="flex flex-col gap-2.5">
              {metaRows.map(([label, value]) => (
                <ReceiptRow key={label} label={label} value={value} mono={label === "Reference" || label === "Transaction ID"} />
              ))}
            </div>
          </div>
        </div>

        <div className="px-5 pb-5">
          {imgError && (
            <p className="text-xs mb-2 text-center" style={{ color: T.warn, fontFamily: FONT_BODY }}>
              {imgError}
            </p>
          )}
          <button
            onClick={shareImage}
            disabled={shareState === "generating"}
            className="w-full rounded-2xl py-3 font-semibold text-sm flex items-center justify-center gap-2 transition-transform active:scale-95 mb-2"
            style={{ background: T.gold, color: T.ink2, fontFamily: FONT_BODY, boxShadow: `0 10px 24px -10px ${T.gold}` }}
          >
            {shareState === "generating" ? <Loader2 size={15} className="animate-spin" /> : <Share2 size={15} />}
            {shareState === "generating" ? "Preparing image..." : "Share receipt"}
          </button>
          <button onClick={copyText} className="w-full text-center text-xs py-1" style={{ color: T.muted, fontFamily: FONT_BODY }}>
            {shareState === "copied" ? "Copied to clipboard" : "Copy as text instead"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReceiptSheet({ payment, senderName, onClose }) {
  useBackClose(onClose);
  const metaRows = [
    ["From", senderName],
    ["For", `${payment.name} (${payment.category})`],
    ["Type", payment.rota_type === "automatic" ? "Automatic Rota" : "Manual Rota"],
    ["Date", payment.paid_at ? new Date(payment.paid_at).toLocaleString("en-NG") : payment.date],
    ["Reference", payment.transaction_ref || "—"],
  ];
  const primarySubline = payment.recipient_account_number
    ? `${payment.recipient_account_number} · ${payment.recipient_bank_name || "—"}`
    : null;

  return (
    <ReceiptCardSheet
      statusLabel="Payment successful"
      statusIcon={<Check size={13} color={T.ok} />}
      amountText={naira(payment.amount)}
      amountColor={T.paper}
      primaryLabel="Paid to"
      primaryName={payment.recipient_account_name || payment.name}
      primarySubline={primarySubline}
      metaRows={metaRows}
      copyLines={[
        "Rota payment receipt",
        `Amount: ${naira(payment.amount)}`,
        `Paid to: ${payment.recipient_account_name || payment.name}`,
        ...(primarySubline ? [`Account: ${primarySubline}`] : []),
        ...metaRows.map(([l, v]) => `${l}: ${v}`),
      ]}
      fileName={`rota-receipt-${payment.id || Date.now()}.png`}
      onClose={onClose}
    />
  );
}

// Same shared receipt design as ReceiptSheet, but for a wallet transaction
// (dva_wallet_transactions row) rather than a scheduled payment.
function WalletReceiptSheet({ txn, onClose }) {
  useBackClose(onClose);
  const isCredit = txn.type === "credit";
  const metaRows = [
    ["Type", isCredit ? "Credit" : "Debit"],
    txn.description ? ["Description", txn.description] : null,
    ["Date", txn.created_at ? new Date(txn.created_at).toLocaleString("en-NG") : "—"],
    ["Reference", txn.id ? String(txn.id).slice(0, 12) : "—"],
  ].filter(Boolean);

  return (
    <ReceiptCardSheet
      statusLabel={isCredit ? "Money received" : "Money sent"}
      statusIcon={isCredit ? <ArrowDownLeft size={13} color={T.ok} /> : <ArrowUpRight size={13} color={T.ok} />}
      amountText={`${isCredit ? "+" : "-"}${naira(txn.amount)}`}
      amountColor={isCredit ? T.ok : T.paper}
      primaryLabel={isCredit ? "From" : "To"}
      primaryName={txn.counterparty_name || (isCredit ? "Bank transfer" : "Recipient")}
      primarySubline={txn.counterparty_bank || null}
      metaRows={metaRows}
      copyLines={[
        `Rota ${isCredit ? "receipt (received)" : "receipt (sent)"}`,
        `Amount: ${isCredit ? "+" : "-"}${naira(txn.amount)}`,
        `${isCredit ? "From" : "To"}: ${txn.counterparty_name || (isCredit ? "Bank transfer" : "Recipient")}`,
        ...metaRows.map(([l, v]) => `${l}: ${v}`),
      ]}
      fileName={`rota-receipt-${txn.id || Date.now()}.png`}
      onClose={onClose}
    />
  );
}

function ReceiptRow({ label, value, mono }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs flex-shrink-0">
        {label}
      </span>
      <span
        style={{ fontFamily: mono ? FONT_MONO : FONT_BODY, color: T.paper }}
        className="text-xs text-right"
      >
        {value}
      </span>
    </div>
  );
}

/* ---------- To-Do tab ---------- */
function TodoTab({ todos, onAdd, onToggle, onDelete }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const done = todos.filter((t) => t.done).length;
  const sorted = [...todos].sort((a, b) => (a.done === b.done ? 0 : a.done ? 1 : -1));

  return (
    <div className="px-5 pb-4">
      <div className="flex items-center justify-between mb-4">
        <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
          {done} of {todos.length} done
        </p>
        <button
          onClick={() => setSheetOpen(true)}
          className="rounded-full flex items-center justify-center transition-transform active:scale-90 flex-shrink-0"
          style={{ width: 40, height: 40, background: T.gold, boxShadow: `0 6px 16px -6px ${T.gold}` }}
        >
          <Plus size={19} color={T.ink2} />
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {sorted.length === 0 && (
          <p className="text-sm text-center py-10" style={{ color: T.muted, fontFamily: FONT_BODY }}>
            No to-dos yet. Tap + to add your first one.
          </p>
        )}
        {sorted.map((t) => (
          <div key={t.id} className="rounded-xl p-3 flex items-center gap-3" style={{ background: T.ink2 }}>
            <button
              onClick={() => onToggle(t.id)}
              className="rounded-md flex items-center justify-center flex-shrink-0"
              style={{
                width: 20,
                height: 20,
                background: t.done ? T.gold : "transparent",
                border: `2px solid ${t.done ? T.gold : T.ink3}`,
              }}
            >
              {t.done && <Check size={12} color={T.ink} />}
            </button>
            <span
              className="text-sm flex-1"
              style={{
                fontFamily: FONT_BODY,
                color: t.done ? T.muted : T.paper,
                textDecoration: t.done ? "line-through" : "none",
              }}
            >
              {t.text}
            </span>
            <button onClick={() => onDelete(t.id)}>
              <Trash2 size={14} color={T.muted} />
            </button>
          </div>
        ))}
      </div>

      {sheetOpen && (
        <AddTodoSheet
          onClose={() => setSheetOpen(false)}
          onSave={async (text) => {
            const ok = await onAdd(text);
            if (ok) setSheetOpen(false);
            return ok;
          }}
        />
      )}
    </div>
  );
}

function AddTodoSheet({ onClose, onSave }) {
  useBackClose(onClose);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    setError("");
    const ok = await onSave(text.trim());
    if (!ok) {
      setError("Couldn't add that — try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 20 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            Add to-do
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>
        <div className="flex flex-col gap-3">
          <div>
            <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
              What do you need to do?
            </label>
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="e.g. Move savings to fixed deposit"
              className="w-full rounded-xl px-3 py-2.5 text-sm"
              style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
            />
          </div>
          {error && (
            <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
              {error}
            </p>
          )}
          <button
            disabled={!text.trim() || submitting}
            onClick={submit}
            className="w-full rounded-2xl py-3 font-semibold text-sm mt-1 flex items-center justify-center gap-2 transition-transform active:scale-95"
            style={{
              background: text.trim() && !submitting ? T.gold : T.ink3,
              color: text.trim() && !submitting ? T.ink2 : T.muted,
              fontFamily: FONT_BODY,
            }}
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {submitting ? "Adding..." : "Add to-do"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Advisor tab ---------- */
function AdvisorTab() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");

  async function getGuidance() {
    if (!question.trim() || loading) return;
    setLoading(true);
    setError("");
    setReply("");
    try {
      const { data, error } = await supabase.functions.invoke("get-advice", { body: { question } });
      if (error || !data?.reply) {
        setError((data && data.error) || "Couldn't reach the guidance service. Try again in a moment.");
        return;
      }
      setReply(data.reply);
    } catch (e) {
      setError("Couldn't reach the guidance service. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="px-5 pb-4 flex flex-col gap-4">
      <div className="rounded-2xl p-4" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <div className="flex items-center gap-2 mb-3">
          <Sparkles size={16} color={T.gold} />
          <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm font-medium">
            Ask for guidance
          </span>
        </div>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. I want to save ₦50,000 this month but rent is due in 3 days..."
          rows={3}
          className="w-full rounded-xl px-3 py-2.5 text-sm mb-3 resize-none"
          style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
        />
        <button
          onClick={getGuidance}
          disabled={!question.trim() || loading}
          className="w-full rounded-xl py-2.5 text-sm font-semibold flex items-center justify-center gap-2 transition-transform active:scale-95"
          style={{
            background: question.trim() && !loading ? T.gold : T.ink3,
            color: question.trim() && !loading ? T.ink2 : T.muted,
            fontFamily: FONT_BODY,
          }}
        >
          {loading && <Loader2 size={14} className="animate-spin" />}
          {loading ? "Thinking..." : "Get guidance"}
        </button>

        {error && (
          <p className="text-xs mt-3" style={{ color: T.warn, fontFamily: FONT_BODY }}>
            {error}
          </p>
        )}
        {reply && (
          <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${T.ink3}` }}>
            <p className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: T.paper, fontFamily: FONT_BODY }}>
              {reply}
            </p>
          </div>
        )}
        <p className="text-xs mt-3" style={{ color: T.muted, fontFamily: FONT_BODY }}>
          General and educational — not personalized financial advice.
        </p>
      </div>
    </div>
  );
}

/* ---------- Profile tab ---------- */
function TapReceiveModeSheet({ value, onSelect, onClose }) {
  useBackClose(onClose);
  const options = [
    {
      key: "quick_accept",
      Icon: Bell,
      title: "Notify",
      description: "A tap drops a quick Accept/Decline notification — no need to open the app. Stays up for a few minutes.",
    },
    {
      key: "open_app",
      Icon: Smartphone,
      title: "Open app",
      description: "A tap opens Rota straight to the accept screen, like scanning a QR code today.",
    },
    {
      key: "auto_accept",
      Icon: Wifi,
      title: "Automatic",
      description: "Money lands the instant you're tapped — no prompt at all. Fastest option, but there's no chance to decline a mistaken tap.",
    },
  ];

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 24 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <div className="flex items-center justify-between mb-1">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            Rota Tap: Alerts
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>
        <p className="text-xs mb-4" style={{ color: T.muted, fontFamily: FONT_BODY }}>
          How should Rota handle an incoming tap when someone sends you money?
        </p>
        <div className="flex flex-col gap-2.5">
          {options.map(({ key, Icon, title, description }) => {
            const active = value === key;
            return (
              <button
                key={key}
                onClick={() => onSelect(key)}
                className="rounded-2xl p-4 flex items-start gap-3 text-left transition-transform active:scale-[0.98]"
                style={{
                  background: active ? `${T.gold}1A` : T.ink,
                  border: `1.5px solid ${active ? T.gold : T.ink3}`,
                }}
              >
                <div
                  className="rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ width: 36, height: 36, background: active ? T.gold : T.ink3 }}
                >
                  <Icon size={17} color={active ? T.ink2 : T.muted} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm font-semibold">
                      {title}
                    </p>
                    {active && <Check size={16} color={T.gold} />}
                  </div>
                  <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs mt-0.5">
                    {description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ProfileTab({ settings, onUpdate, onLogout, onReset, onUnlink, onUploadAvatar, onBiometricChange, hasBiometricConfirm, email, onCardLinked, accountNumber }) {
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(settings.name);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const [pwSheetOpen, setPwSheetOpen] = useState(false);
  const [pinSheetOpen, setPinSheetOpen] = useState(false);
  const [cardSheetOpen, setCardSheetOpen] = useState(false);
  const [linkOverlayOpen, setLinkOverlayOpen] = useState(false);
  const [tapModeSheetOpen, setTapModeSheetOpen] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);
  const [bioError, setBioError] = useState("");
  const [editingField, setEditingField] = useState(null); // { key, label, type, options } | null
  const [emailRevealed, setEmailRevealed] = useState(false);
  const [accountCopied, setAccountCopied] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetAuthOpen, setResetAuthOpen] = useState(false);
  const fileInputRef = useRef(null);

  // These two overlays are plain inline JSX rather than separate sheet
  // components, so they need their own useBackClose calls — every other
  // sheet below registers its own via its component body.
  useBackClose(() => setResetConfirmOpen(false), resetConfirmOpen);
  useBackClose(() => setLinkOverlayOpen(false), linkOverlayOpen);

  function copyAccountNumber() {
    if (!accountNumber) return;
    navigator.clipboard?.writeText(accountNumber).then(() => {
      setAccountCopied(true);
      setTimeout(() => setAccountCopied(false), 1500);
    });
  }

  async function enableBiometric() {
    setBioBusy(true);
    setBioError("");
    try {
      if (IS_NATIVE) {
        const avail = await NativeBiometric.isAvailable();
        if (!avail.isAvailable) throw new Error("No fingerprint/face unlock is set up on this device yet — add one in your phone's settings first.");
        const { data, error: enrollErr } = await supabase.functions.invoke("native-biometric-enroll", { body: {} });
        if (enrollErr || !data?.success) throw new Error((data && data.error) || "Couldn't enable biometrics.");
        await NativeBiometric.setCredentials({ username: "rota", password: data.secret, server: NATIVE_BIO_SERVER });
        // Remembers which account this device's enrollment belongs to, so the
        // signed-out login screen can offer a fingerprint quick-login for it.
        const { data: userData } = await supabase.auth.getUser();
        if (userData?.user) {
          localStorage.setItem(NATIVE_BIO_USER_KEY, userData.user.id);
          localStorage.setItem(NATIVE_BIO_LABEL_KEY, userData.user.email || "");
        }
        onBiometricChange(true);
        return;
      }
      if (!browserSupportsWebAuthn()) throw new Error("This browser doesn't support biometric sign-in.");
      const { data: options, error: optErr } = await supabase.functions.invoke("webauthn-register-options", { body: {} });
      if (optErr || options?.error) throw new Error((options && options.error) || "Couldn't start registration.");
      const attResp = await startRegistration({ optionsJSON: options });
      const { data, error: verErr } = await supabase.functions.invoke("webauthn-register-verify", { body: { response: attResp } });
      if (verErr || !data?.success) throw new Error((data && data.error) || "Couldn't verify that device.");
      onBiometricChange(true);
    } catch (e) {
      const cancelled = e?.name === "NotAllowedError" || String(e?.message || "").toLowerCase().includes("cancel");
      if (!cancelled) setBioError(e.message || "Couldn't enable biometrics.");
    } finally {
      setBioBusy(false);
    }
  }

  async function disableBiometric() {
    setBioBusy(true);
    setBioError("");
    if (IS_NATIVE) {
      try {
        await NativeBiometric.deleteCredentials({ server: NATIVE_BIO_SERVER });
      } catch {
        // no stored credential to delete — fine, still clear server-side below
      }
      const { data, error } = await supabase.functions.invoke("native-biometric-unenroll", { body: {} });
      setBioBusy(false);
      if (error || !data?.success) {
        setBioError("Couldn't remove biometrics.");
        return;
      }
      localStorage.removeItem(NATIVE_BIO_USER_KEY);
      localStorage.removeItem(NATIVE_BIO_LABEL_KEY);
      onBiometricChange(false);
      return;
    }
    const { data, error } = await supabase.functions.invoke("webauthn-unregister", { body: {} });
    setBioBusy(false);
    if (error || !data?.success) {
      setBioError("Couldn't remove biometrics.");
      return;
    }
    onBiometricChange(false);
  }

  useEffect(() => {
    setName(settings.name);
  }, [settings.name]);

  function startEdit() {
    setName(settings.name);
    setEditingName(true);
  }

  function saveName() {
    if (name.trim().length > 0 && name.trim() !== settings.name) {
      onUpdate({ name: name.trim() });
    }
    setEditingName(false);
  }

  function cancelEdit() {
    setName(settings.name);
    setEditingName(false);
  }

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Hey" : hour < 17 ? "Hi" : "Hello";

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setAvatarError("Image must be under 5MB.");
      return;
    }
    setUploadingAvatar(true);
    setAvatarError("");
    const result = await onUploadAvatar(file);
    if (!result.ok) setAvatarError(result.message || "Couldn't upload that image. Try again.");
    setUploadingAvatar(false);
  }

  return (
    <div className="px-5 pb-4 flex flex-col gap-4">
      <div className="rounded-2xl p-4" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <div className="flex flex-col items-start mb-3">
          {editingName ? (
            <div className="flex gap-2 w-full mb-3">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveName()}
                className="flex-1 min-w-0 rounded-xl px-3 py-2 text-sm"
                style={{ background: T.ink, border: `1px solid ${T.gold}`, color: T.paper, fontFamily: FONT_BODY }}
              />
              <button
                onClick={saveName}
                className="rounded-xl px-2.5 flex items-center justify-center flex-shrink-0 transition-transform active:scale-95"
                style={{ background: T.gold }}
              >
                <Check size={16} color={T.ink2} />
              </button>
              <button
                onClick={cancelEdit}
                className="rounded-xl px-2.5 flex items-center justify-center flex-shrink-0 transition-transform active:scale-95"
                style={{ background: T.ink3 }}
              >
                <X size={16} color={T.muted} />
              </button>
            </div>
          ) : (
            <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-base font-medium mb-3">
              {greeting}, {settings.name}
            </span>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadingAvatar}
            className="rounded-full overflow-hidden flex items-center justify-center relative flex-shrink-0"
            style={{ width: 64, height: 64, background: T.gold }}
          >
            {settings.avatarUrl ? (
              <img src={settings.avatarUrl} alt="" className="w-full h-full" style={{ objectFit: "cover" }} />
            ) : (
              <span style={{ fontFamily: FONT_DISPLAY, color: T.ink2 }} className="text-2xl font-semibold">
                {settings.name.charAt(0).toUpperCase()}
              </span>
            )}
            {uploadingAvatar && (
              <div className="absolute inset-0 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.45)" }}>
                <Loader2 size={20} color={T.ink2} className="animate-spin" />
              </div>
            )}
            <div
              className="absolute bottom-0 right-0 rounded-full flex items-center justify-center"
              style={{ width: 20, height: 20, background: T.paper, border: `2px solid ${T.ink2}` }}
            >
              <Pencil size={9} color={T.ink2} />
            </div>
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
        </div>
        {avatarError && (
          <p className="text-xs mb-1" style={{ color: T.warn, fontFamily: FONT_BODY }}>
            {avatarError}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => (settings.cardLinked ? setCardSheetOpen(true) : setLinkOverlayOpen(true))}
            className="flex items-center gap-1.5"
          >
            <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
              {settings.cardLinked ? `Debit card •••• ${settings.cardLast4}` : "No card linked — tap to add"}
            </p>
            <ChevronDown size={11} color={T.muted} style={{ transform: "rotate(-90deg)" }} />
          </button>
          {!editingName && (
            <button
              onClick={startEdit}
              className="rounded-lg flex items-center justify-center flex-shrink-0 transition-transform active:scale-95"
              style={{ width: 28, height: 28, background: T.ink, border: `1px solid ${T.ink3}` }}
            >
              <Pencil size={12} color={T.paper} />
            </button>
          )}
        </div>
        {accountNumber && (
          <button onClick={copyAccountNumber} className="flex items-center gap-2 mt-2.5 rounded-xl px-3 py-2" style={{ background: T.ink, border: `1px solid ${T.ink3}` }}>
            <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-[11px]">
              Account Number
            </span>
            <span style={{ fontFamily: FONT_MONO, color: T.gold }} className="text-sm font-bold tracking-wide">
              {accountNumber}
            </span>
            <Copy size={13} color={T.gold} />
            {accountCopied && (
              <span style={{ color: T.ok, fontFamily: FONT_BODY }} className="text-xs">
                Copied
              </span>
            )}
          </button>
        )}
      </div>

      <div className="rounded-2xl overflow-hidden" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <Row icon={User} label="Full Name">
          <button onClick={() => setEditingField({ key: "name", label: "Full Name", type: "text", value: settings.name })} className="flex items-center gap-1.5">
            <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs truncate max-w-[140px]">
              {settings.name || "Add name"}
            </span>
            <ChevronDown size={11} color={T.muted} style={{ transform: "rotate(-90deg)" }} />
          </button>
        </Row>
        <Row icon={Smartphone} label="Mobile Number">
          <div className="flex items-center gap-2">
            {settings.phone && (
              settings.phoneVerified ? (
                <span className="flex items-center gap-1" style={{ color: T.ok, fontFamily: FONT_BODY }}>
                  <ShieldCheck size={11} /> <span className="text-xs">Verified</span>
                </span>
              ) : (
                <button
                  onClick={() => setVerifyOpen(true)}
                  className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  style={{ background: `${T.gold}22`, color: T.gold, fontFamily: FONT_BODY }}
                >
                  Verify
                </button>
              )
            )}
            <button onClick={() => setEditingField({ key: "phone", label: "Mobile Number", type: "tel", value: settings.phone })} className="flex items-center gap-1.5">
              <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
                {settings.phone || "Add number"}
              </span>
              <ChevronDown size={11} color={T.muted} style={{ transform: "rotate(-90deg)" }} />
            </button>
          </div>
        </Row>
        <Row icon={Pencil} label="Nickname">
          <button onClick={() => setEditingField({ key: "nickname", label: "Nickname", type: "text", value: settings.nickname })} className="flex items-center gap-1.5">
            <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
              {settings.nickname || "Add nickname"}
            </span>
            <ChevronDown size={11} color={T.muted} style={{ transform: "rotate(-90deg)" }} />
          </button>
        </Row>
        <Row icon={User} label="Gender">
          <button
            onClick={() => setEditingField({ key: "gender", label: "Gender", type: "options", options: ["Male", "Female", "Prefer not to say"], value: settings.gender })}
            className="flex items-center gap-1.5"
          >
            <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
              {settings.gender || "Add gender"}
            </span>
            <ChevronDown size={11} color={T.muted} style={{ transform: "rotate(-90deg)" }} />
          </button>
        </Row>
        <Row icon={Clock} label="Date of Birth">
          <button onClick={() => setEditingField({ key: "dateOfBirth", label: "Date of Birth", type: "date", value: settings.dateOfBirth })} className="flex items-center gap-1.5">
            <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
              {maskDate(settings.dateOfBirth)}
            </span>
            <ChevronDown size={11} color={T.muted} style={{ transform: "rotate(-90deg)" }} />
          </button>
        </Row>
        <Row icon={ShieldCheck} label="Email">
          <button onClick={() => setEmailRevealed((v) => !v)} className="flex items-center gap-1.5">
            <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
              {emailRevealed ? email || "—" : maskEmail(email)}
            </span>
          </button>
        </Row>
        <Row icon={Landmark} label="Address">
          <button onClick={() => setEditingField({ key: "address", label: "Address", type: "text", value: settings.address })} className="flex items-center gap-1.5">
            <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs truncate max-w-[140px]">
              {settings.address || "Add address"}
            </span>
            <ChevronDown size={11} color={T.muted} style={{ transform: "rotate(-90deg)" }} />
          </button>
        </Row>
      </div>

      <div className="rounded-2xl overflow-hidden" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <Row icon={Bell} label="Notifications">
          <Toggle value={settings.notifications} onChange={(v) => onUpdate({ notifications: v })} />
        </Row>
        <Row icon={Moon} label="Dark mode">
          <Toggle value={settings.darkMode} onChange={(v) => onUpdate({ darkMode: v })} />
        </Row>
        <button onClick={() => setPwSheetOpen(true)} className="w-full text-left">
          <Row icon={Lock} label="Change password">
            <ChevronDown size={14} color={T.muted} style={{ transform: "rotate(-90deg)" }} />
          </Row>
        </button>
        <button onClick={() => setPinSheetOpen(true)} className="w-full text-left">
          <Row icon={ShieldCheck} label={settings.hasPin ? "Change transaction PIN" : "Set transaction PIN"}>
            <ChevronDown size={14} color={T.muted} style={{ transform: "rotate(-90deg)" }} />
          </Row>
        </button>
        <Row
          icon={Fingerprint}
          label="Biometric login"
          sub={IS_NATIVE ? "Sign in and confirm payments with your fingerprint or face" : "Confirm payments with your device's biometrics"}
        >
          {bioBusy ? (
            <Loader2 size={14} className="animate-spin" color={T.muted} />
          ) : hasBiometricConfirm ? (
            <button onClick={disableBiometric} className="text-xs font-medium" style={{ color: T.warn, fontFamily: FONT_BODY }}>
              Remove
            </button>
          ) : IS_NATIVE || browserSupportsWebAuthn() ? (
            <button onClick={enableBiometric} className="text-xs font-medium" style={{ color: T.gold, fontFamily: FONT_BODY }}>
              Enable
            </button>
          ) : (
            <span className="text-xs" style={{ color: T.muted, fontFamily: FONT_BODY }}>
              Not available in app
            </span>
          )}
        </Row>
        {IS_NATIVE && (
          <button onClick={() => setTapModeSheetOpen(true)} className="w-full text-left">
            <Row icon={Wifi} label="Rota Tap: Alerts">
              <span className="flex items-center gap-1.5">
                <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
                  {TAP_RECEIVE_MODE_LABELS[settings.tapReceiveMode] || TAP_RECEIVE_MODE_LABELS.quick_accept}
                </span>
                <ChevronDown size={14} color={T.muted} style={{ transform: "rotate(-90deg)" }} />
              </span>
            </Row>
          </button>
        )}
        <Row icon={Wallet} label="Currency">
          <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-sm">
            ₦ Naira
          </span>
        </Row>
      </div>
      {bioError && (
        <p className="text-xs -mt-2" style={{ color: T.warn, fontFamily: FONT_BODY }}>
          {bioError}
        </p>
      )}

      <button
        onClick={() => setResetConfirmOpen(true)}
        className="rounded-2xl p-3.5 flex items-center gap-3"
        style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}
      >
        <RotateCcw size={16} color={T.muted} />
        <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm">
          Clear all data
        </span>
      </button>
      {resetConfirmOpen && (
        <div className="absolute inset-0 flex items-center justify-center px-6" style={{ zIndex: 24, background: "rgba(0,0,0,0.6)" }}>
          <div className="rounded-2xl p-5 w-full max-w-sm" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
            <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-base font-semibold mb-2">
              Clear all data?
            </h3>
            <p className="text-xs mb-4" style={{ color: T.muted, fontFamily: FONT_BODY }}>
              This permanently deletes every scheduled Rota and to-do on this account. It can't be undone.{" "}
              {settings.hasPin ? "You'll need to confirm with your PIN or biometrics next." : ""}
            </p>
            {!settings.hasPin && (
              <p className="text-xs mb-4" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                Set a transaction PIN above before you can clear data.
              </p>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => setResetConfirmOpen(false)}
                className="flex-1 rounded-xl py-2.5 text-sm font-semibold"
                style={{ background: T.ink3, color: T.paper, fontFamily: FONT_BODY }}
              >
                Cancel
              </button>
              <button
                disabled={!settings.hasPin}
                onClick={() => {
                  setResetConfirmOpen(false);
                  setResetAuthOpen(true);
                }}
                className="flex-1 rounded-xl py-2.5 text-sm font-semibold"
                style={{ background: settings.hasPin ? T.warn : T.ink3, color: settings.hasPin ? T.ink2 : T.muted, fontFamily: FONT_BODY }}
              >
                Yes, clear it
              </button>
            </div>
          </div>
        </div>
      )}
      {resetAuthOpen && (
        <ConfirmSheet
          hasBiometric={hasBiometricConfirm}
          title="Confirm to clear all data"
          actionLabel="Confirm with PIN"
          onClose={() => setResetAuthOpen(false)}
          onConfirmed={() => {
            setResetAuthOpen(false);
            onReset();
          }}
        />
      )}

      <button onClick={onLogout} className="rounded-2xl p-3.5 flex items-center gap-3" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <LogOut size={16} color={T.warn} />
        <span style={{ fontFamily: FONT_BODY, color: T.warn }} className="text-sm">
          Log out
        </span>
      </button>

      {pwSheetOpen && <PasswordChangeSheet onClose={() => setPwSheetOpen(false)} />}
      {editingField && (
        <EditFieldSheet
          field={editingField}
          onClose={() => setEditingField(null)}
          onSave={(value) => {
            // A phone that just changed can't still be the verified one.
            onUpdate(editingField.key === "phone" ? { phone: value, phoneVerified: false } : { [editingField.key]: value });
            setEditingField(null);
          }}
        />
      )}
      {verifyOpen && (
        <PhoneVerifySheet
          onClose={() => setVerifyOpen(false)}
          onVerified={() => {
            onUpdate({ phoneVerified: true });
            setVerifyOpen(false);
          }}
        />
      )}
      {tapModeSheetOpen && (
        <TapReceiveModeSheet
          value={settings.tapReceiveMode}
          onSelect={(mode) => {
            onUpdate({ tapReceiveMode: mode });
            setTapModeSheetOpen(false);
          }}
          onClose={() => setTapModeSheetOpen(false)}
        />
      )}
      {pinSheetOpen && (
        <PinSheet
          hasPin={settings.hasPin}
          onClose={() => setPinSheetOpen(false)}
          onDone={() => onUpdate({ hasPin: true })}
        />
      )}
      {cardSheetOpen && (
        <CardDetailSheet
          last4={settings.cardLast4}
          hasPin={settings.hasPin}
          hasBiometric={hasBiometricConfirm}
          onClose={() => setCardSheetOpen(false)}
          onChangeCard={() => {
            setCardSheetOpen(false);
            onUnlink();
          }}
        />
      )}
      {linkOverlayOpen && (
        <div className="absolute inset-0 flex justify-center" style={{ zIndex: 26, background: T.ink }}>
          <div className="relative w-full max-w-lg h-full">
            <button
              onClick={() => setLinkOverlayOpen(false)}
              className="absolute rounded-full flex items-center justify-center"
              style={{ top: 18, right: 18, width: 30, height: 30, background: T.ink2, border: `1px solid ${T.ink3}`, zIndex: 27 }}
            >
              <X size={16} color={T.muted} />
            </button>
            <LinkScreen
              email={email}
              onLinked={(last4) => {
                onCardLinked(last4);
                setLinkOverlayOpen(false);
              }}
              onSkip={() => setLinkOverlayOpen(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function CardDetailSheet({ last4, hasPin, hasBiometric, onClose, onChangeCard }) {
  useBackClose(onClose);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 22 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            Card details
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>

        <div
          className="rounded-2xl p-5 mb-4"
          style={{ background: `linear-gradient(135deg, ${T.ink3}, ${T.ink2})`, border: `1px solid ${T.ink3}` }}
        >
          <div className="flex items-center justify-between mb-8">
            <div className="rounded" style={{ width: 34, height: 24, background: T.goldSoft }} />
            <CreditCard size={20} color={T.muted} />
          </div>
          <div style={{ fontFamily: FONT_MONO, color: T.paper, letterSpacing: 2 }} className="text-lg mb-3">
            •••• •••• •••• {last4 || "----"}
          </div>
          <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
            SECURED BY PAYSTACK
          </span>
        </div>

        <p className="text-xs mb-3" style={{ color: T.muted, fontFamily: FONT_BODY }}>
          Changing your card unlinks this one and takes you through linking a new one — confirm with your PIN or
          biometrics first, since this affects how Automatic Rotas get charged.
        </p>

        {!hasPin ? (
          <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
            Set a transaction PIN in Settings before changing your card.
          </p>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="w-full rounded-2xl py-3 font-semibold text-sm transition-transform active:scale-95"
            style={{ background: T.warn, color: T.ink2, fontFamily: FONT_BODY }}
          >
            Change card
          </button>
        )}
      </div>
      {confirming && (
        <ConfirmSheet
          hasBiometric={hasBiometric}
          onClose={() => setConfirming(false)}
          onConfirmed={() => {
            setConfirming(false);
            onChangeCard();
          }}
        />
      )}
    </div>
  );
}

function PinInput({ label, value, onChange, autoFocus }) {
  return (
    <div>
      <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
        {label}
      </label>
      <input
        autoFocus={autoFocus}
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={4}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 4))}
        className="w-full rounded-xl px-3 py-2.5 text-lg text-center"
        style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_MONO, letterSpacing: 10 }}
      />
    </div>
  );
}

function PinSheet({ hasPin, onClose, onDone }) {
  useBackClose(onClose);
  const [currentPin, setCurrentPin] = useState("");
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function submit() {
    if (!/^\d{4}$/.test(pin)) {
      setError("New PIN must be 4 digits.");
      return;
    }
    if (pin !== confirmPin) {
      setError("PINs don't match.");
      return;
    }
    if (hasPin && !/^\d{4}$/.test(currentPin)) {
      setError("Enter your current PIN.");
      return;
    }
    setSubmitting(true);
    setError("");
    const { data, error: fnError } = await supabase.functions.invoke("set-pin", {
      body: hasPin ? { pin, current_pin: currentPin } : { pin },
    });
    setSubmitting(false);
    if (fnError || !data?.success) {
      setError((data && data.error) || "Couldn't set PIN. Try again.");
      return;
    }
    setDone(true);
    onDone();
  }

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 22 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            {hasPin ? "Change transaction PIN" : "Set a transaction PIN"}
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>
        {done ? (
          <p className="text-sm" style={{ color: T.ok, fontFamily: FONT_BODY }}>
            Your PIN has been {hasPin ? "updated" : "set"}.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-xs" style={{ color: T.muted, fontFamily: FONT_BODY }}>
              You'll be asked for this PIN whenever you finalize a scheduled Rota.
            </p>
            {hasPin && <PinInput label="Current PIN" value={currentPin} onChange={setCurrentPin} autoFocus />}
            <PinInput label="New PIN" value={pin} onChange={setPin} autoFocus={!hasPin} />
            <PinInput label="Confirm new PIN" value={confirmPin} onChange={setConfirmPin} />
            {error && (
              <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                {error}
              </p>
            )}
            <button
              disabled={submitting}
              onClick={submit}
              className="w-full rounded-2xl py-3 font-semibold text-sm mt-1 flex items-center justify-center gap-2 transition-transform active:scale-95"
              style={{ background: T.gold, color: T.ink2, fontFamily: FONT_BODY }}
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              {submitting ? "Saving..." : hasPin ? "Update PIN" : "Set PIN"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ConfirmSheet({ hasBiometric, onBack, onClose, onConfirmed, title = "Confirm to schedule", actionLabel = "Confirm with PIN" }) {
  useBackClose(onBack || onClose);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const kbInset = useKeyboardInset();

  async function tryBiometric() {
    setError("");
    setSubmitting(true);
    try {
      if (IS_NATIVE) {
        await NativeBiometric.verifyIdentity({ title: "Confirm it's you", reason: "Confirm this transaction" });
        const creds = await NativeBiometric.getCredentials({ server: NATIVE_BIO_SERVER });
        const { data, error: verErr } = await supabase.functions.invoke("native-biometric-verify", { body: { secret: creds.password } });
        if (verErr || !data?.success) throw new Error((data && data.error) || "Couldn't verify.");
        onConfirmed();
        return;
      }
      if (!browserSupportsWebAuthn()) throw new Error("This browser doesn't support biometrics — use your PIN.");
      const { data: options, error: optErr } = await supabase.functions.invoke("webauthn-auth-options", { body: {} });
      if (optErr || options?.error) throw new Error((options && options.error) || "Biometrics unavailable.");
      const assertion = await startAuthentication({ optionsJSON: options });
      const { data, error: verErr } = await supabase.functions.invoke("webauthn-auth-verify", { body: { response: assertion } });
      if (verErr || !data?.success) throw new Error((data && data.error) || "Couldn't verify.");
      onConfirmed();
    } catch (e) {
      const cancelled = e?.name === "NotAllowedError" || String(e?.message || "").toLowerCase().includes("cancel");
      if (!cancelled) setError(e.message || "Couldn't verify — use your PIN instead.");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitPin() {
    if (!/^\d{4}$/.test(pin)) {
      setError("Enter your 4-digit PIN.");
      return;
    }
    setSubmitting(true);
    setError("");
    const { data, error: verErr } = await supabase.functions.invoke("verify-pin", { body: { pin } });
    setSubmitting(false);
    if (verErr || !data?.success) {
      setError((data && data.error) || "Incorrect PIN.");
      setPin("");
      return;
    }
    onConfirmed();
  }

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 24, paddingBottom: kbInset }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <div className="flex items-center gap-2 mb-4">
          {onBack && (
            <button onClick={onBack} className="flex-shrink-0">
              <ChevronDown size={18} color={T.muted} style={{ transform: "rotate(90deg)" }} />
            </button>
          )}
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold flex-1">
            {title}
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>
        {hasBiometric && (
          <button
            onClick={tryBiometric}
            disabled={submitting}
            className="w-full rounded-2xl py-3 font-semibold text-sm flex items-center justify-center gap-2 mb-3 transition-transform active:scale-95"
            style={{ background: T.ink3, color: T.paper, fontFamily: FONT_BODY }}
          >
            <Fingerprint size={16} /> Use biometrics
          </button>
        )}
        <PinInput label="Transaction PIN" value={pin} onChange={setPin} autoFocus={!hasBiometric} />
        {error && (
          <p className="text-xs mt-2" style={{ color: T.warn, fontFamily: FONT_BODY }}>
            {error}
          </p>
        )}
        <button
          disabled={submitting || pin.length !== 4}
          onClick={submitPin}
          className="w-full rounded-2xl py-3 font-semibold text-sm mt-3 flex items-center justify-center gap-2 transition-transform active:scale-95"
          style={{
            background: pin.length === 4 ? T.gold : T.ink3,
            color: pin.length === 4 ? T.ink2 : T.muted,
            fontFamily: FONT_BODY,
          }}
        >
          {submitting && <Loader2 size={14} className="animate-spin" />}
          {actionLabel}
        </button>
      </div>
    </div>
  );
}

function PasswordChangeSheet({ onClose }) {
  useBackClose(onClose);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function submit() {
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    setError("");
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setSubmitting(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setDone(true);
  }

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 22 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            Change password
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>
        {done ? (
          <p className="text-sm" style={{ color: T.ok, fontFamily: FONT_BODY }}>
            Your password has been updated.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
                New password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                className="w-full rounded-xl px-3 py-2.5 text-sm"
                style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
              />
            </div>
            <div>
              <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
                Confirm new password
              </label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                className="w-full rounded-xl px-3 py-2.5 text-sm"
                style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
              />
            </div>
            {error && (
              <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                {error}
              </p>
            )}
            <button
              disabled={submitting}
              onClick={submit}
              className="w-full rounded-2xl py-3 font-semibold text-sm mt-1 flex items-center justify-center gap-2 transition-transform active:scale-95"
              style={{ background: T.gold, color: T.ink2, fontFamily: FONT_BODY }}
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              {submitting ? "Updating..." : "Update password"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ icon: Icon, label, sub, children }) {
  return (
    <div className="flex items-center justify-between px-4 py-3.5" style={{ borderBottom: `1px solid ${T.ink3}` }}>
      <div className="flex items-center gap-3 min-w-0">
        <Icon size={16} color={T.muted} />
        <div className="flex flex-col min-w-0">
          <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm">
            {label}
          </span>
          {sub && (
            <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-[11px]">
              {sub}
            </span>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

function Toggle({ value, onChange }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="rounded-full relative transition-colors"
      style={{ width: 40, height: 24, background: value ? T.gold : T.ink3 }}
    >
      <span
        className="rounded-full absolute transition-all"
        style={{ width: 18, height: 18, top: 3, left: value ? 19 : 3, background: T.ink }}
      />
    </button>
  );
}

// One small edit sheet reused for every profile field (name, phone, nickname,
// gender, date of birth, address) instead of five near-identical ones —
// `field.type` switches between a plain text input, a numeric/tel input, a
// native date picker, or a set of selectable option pills.
function EditFieldSheet({ field, onClose, onSave }) {
  useBackClose(onClose);
  const [value, setValue] = useState(field.value || "");
  const canSave = field.type === "options" ? !!value : String(value).trim().length > 0;

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 24 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            {field.label}
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>

        {field.type === "options" ? (
          <div className="flex flex-col gap-2 mb-4">
            {field.options.map((opt) => (
              <button
                key={opt}
                onClick={() => setValue(opt)}
                className="rounded-xl px-3 py-2.5 text-sm text-left flex items-center justify-between"
                style={{ background: T.ink, border: `1px solid ${value === opt ? T.gold : T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
              >
                {opt}
                {value === opt && <Check size={14} color={T.gold} />}
              </button>
            ))}
          </div>
        ) : (
          <input
            autoFocus
            type={field.type === "date" ? "date" : field.type === "tel" ? "tel" : "text"}
            value={value}
            onChange={(e) => setValue(field.type === "tel" ? e.target.value.replace(/\D/g, "").slice(0, 11) : e.target.value)}
            placeholder={`Enter ${field.label.toLowerCase()}`}
            className="w-full rounded-xl px-3 py-2.5 text-sm mb-4"
            style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: field.type === "tel" ? FONT_MONO : FONT_BODY }}
          />
        )}

        <button
          disabled={!canSave}
          onClick={() => onSave(value)}
          className="w-full rounded-2xl py-3 font-semibold text-sm transition-transform active:scale-95"
          style={{ background: canSave ? T.gold : T.ink3, color: canSave ? T.ink2 : T.muted, fontFamily: FONT_BODY }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

// Sends a code to the signed-in user's own account email (see
// phone-verify-request) rather than the phone itself — no SMS provider
// needed, since the email address is already proven by having signed up.
function PhoneVerifySheet({ onClose, onVerified }) {
  useBackClose(onClose);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");

  async function sendCode() {
    setSending(true);
    setError("");
    const { data, error: err } = await supabase.functions.invoke("phone-verify-request", { body: {} });
    setSending(false);
    if (err || !data?.ok) {
      setError((data && data.error) || "Couldn't send a code.");
      return;
    }
    setSent(true);
  }

  async function confirmCode() {
    if (code.trim().length !== 6) {
      setError("Enter the 6-digit code.");
      return;
    }
    setVerifying(true);
    setError("");
    const { data, error: err } = await supabase.functions.invoke("phone-verify-confirm", { body: { code: code.trim() } });
    setVerifying(false);
    if (err || !data?.ok) {
      setError((data && data.error) || "Incorrect code.");
      return;
    }
    onVerified();
  }

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 24 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            Verify Mobile Number
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>

        {sent ? (
          <>
            <p className="text-xs mb-3" style={{ color: T.muted, fontFamily: FONT_BODY }}>
              Enter the 6-digit code sent to your account email.
            </p>
            <input
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              inputMode="numeric"
              className="w-full rounded-xl px-3 py-2.5 text-center text-lg tracking-[0.4em] mb-3"
              style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_MONO }}
            />
            {error && (
              <p className="text-xs mb-3" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                {error}
              </p>
            )}
            <button
              disabled={code.length !== 6 || verifying}
              onClick={confirmCode}
              className="w-full rounded-2xl py-3 font-semibold text-sm transition-transform active:scale-95"
              style={{ background: code.length === 6 ? T.gold : T.ink3, color: code.length === 6 ? T.ink2 : T.muted, fontFamily: FONT_BODY }}
            >
              {verifying ? "Verifying…" : "Verify"}
            </button>
          </>
        ) : (
          <>
            <p className="text-xs mb-4" style={{ color: T.muted, fontFamily: FONT_BODY }}>
              We'll send a 6-digit code to your account email to confirm this number is yours.
            </p>
            {error && (
              <p className="text-xs mb-3" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                {error}
              </p>
            )}
            <button
              disabled={sending}
              onClick={sendCode}
              className="w-full rounded-2xl py-3 font-semibold text-sm transition-transform active:scale-95"
              style={{ background: T.gold, color: T.ink2, fontFamily: FONT_BODY }}
            >
              {sending ? "Sending…" : "Send code"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- Auth ---------- */
// Web keeps the normal page-redirect flow, back to the app's own origin.
const OAUTH_REDIRECT_URL = "https://rota-app-zerubbabel1.vercel.app/";

// Native opens Google's consent screen in the system browser (Google
// actively blocks OAuth inside embedded WebViews) and needs to be handed
// back to the app afterwards. An HTTPS App Link redirect looked like the
// obvious choice here — rota-app-zerubbabel1.vercel.app is already verified
// for that — but Android only intercepts an App Link on the *initial*
// external navigation to it; a same-tab HTTP redirect chain (Google →
// Supabase's callback → this URL) never re-triggers that interception, so
// the browser just loaded the live website's own login screen instead of
// handing anything back to the app. A custom URL scheme doesn't have that
// carve-out — browsers always hand an unrecognized scheme to the OS to
// route, redirect or not — which is why this is the scheme mobile OAuth
// redirects normally use. Must also be added as a redirect URL in
// Supabase's dashboard, and matches the intent-filter in
// AndroidManifest.xml.
const NATIVE_OAUTH_REDIRECT_URL = "com.rota.app://auth-callback";

function AuthScreen() {
  const [mode, setMode] = useState("login");
  // Login only — one field, auto-detects email vs. phone number by whether
  // it contains "@" rather than making the user pick a mode first. Signup
  // is always email, via the separate `email` field below.
  const [identifier, setIdentifier] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const [bioSubmitting, setBioSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [checkEmail, setCheckEmail] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [forgotError, setForgotError] = useState("");
  // Set only if THIS device previously enrolled biometrics for some account
  // (see ProfileTab's enableBiometric) — a fresh install has neither key,
  // which is exactly what should force the real password.
  const [biometricUserId] = useState(() => (IS_NATIVE ? localStorage.getItem(NATIVE_BIO_USER_KEY) : null));
  const [biometricLabel] = useState(() => (IS_NATIVE ? localStorage.getItem(NATIVE_BIO_LABEL_KEY) : null));

  async function submit() {
    if (mode === "signup") {
      if (!email.trim() || !password || submitting) return;
      setSubmitting(true);
      setError("");
      setCheckEmail(false);
      const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
      if (error) setError(error.message);
      else if (!data.session) setCheckEmail(true);
      setSubmitting(false);
      return;
    }
    const trimmed = identifier.trim();
    if (!trimmed || !password || submitting) return;
    setSubmitting(true);
    setError("");
    setCheckEmail(false);
    if (trimmed.includes("@")) {
      const { error } = await supabase.auth.signInWithPassword({ email: trimmed, password });
      if (error) setError(error.message);
    } else {
      const phoneDigits = trimmed.replace(/\D/g, "");
      const { data, error: fnError } = await supabase.functions.invoke("login-with-phone", { body: { phone: phoneDigits, password } });
      if (fnError || !data?.ok) {
        setError((data && data.error) || "Couldn't sign in.");
      } else {
        const { error: sessErr } = await supabase.auth.setSession({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        });
        if (sessErr) setError(sessErr.message);
      }
    }
    setSubmitting(false);
  }

  async function submitForgotPassword() {
    const trimmed = forgotEmail.trim();
    if (!trimmed || forgotSubmitting) return;
    setForgotSubmitting(true);
    setForgotError("");
    const { error } = await supabase.auth.resetPasswordForEmail(trimmed, {
      redirectTo: IS_NATIVE ? NATIVE_OAUTH_REDIRECT_URL : OAUTH_REDIRECT_URL,
    });
    if (error) setForgotError(error.message);
    else setForgotSent(true);
    setForgotSubmitting(false);
  }

  // Signed-out biometric quick-login: proves the device's Keystore-held
  // secret still matches what's on file (native-biometric-login), then
  // exchanges that proof for a real session via Supabase's own magic-link
  // token issuance rather than any custom-minted token.
  async function loginWithBiometric() {
    if (!biometricUserId || bioSubmitting) return;
    setBioSubmitting(true);
    setError("");
    try {
      await NativeBiometric.verifyIdentity({ title: "Log in to Rota", reason: "Confirm it's you" });
      const creds = await NativeBiometric.getCredentials({ server: NATIVE_BIO_SERVER });
      const { data, error: fnError } = await supabase.functions.invoke("native-biometric-login", {
        body: { userId: biometricUserId, secret: creds.password },
      });
      if (fnError || !data?.ok) throw new Error((data && data.error) || "Couldn't sign in — use your password instead.");
      const { error: verErr } = await supabase.auth.verifyOtp({ token_hash: data.token_hash, type: "magiclink" });
      if (verErr) throw verErr;
    } catch (e) {
      const cancelled = e?.name === "NotAllowedError" || String(e?.message || "").toLowerCase().includes("cancel");
      if (!cancelled) setError(e.message || "Couldn't sign in — use your password instead.");
    } finally {
      setBioSubmitting(false);
    }
  }

  async function signInWithGoogle() {
    if (googleSubmitting) return;
    setGoogleSubmitting(true);
    setError("");
    try {
      if (IS_NATIVE) {
        const { data, error } = await supabase.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: NATIVE_OAUTH_REDIRECT_URL, skipBrowserRedirect: true },
        });
        if (error) throw error;
        console.log("[RotaAuth] got OAuth url:", data?.url);
        if (data?.url) await Browser.open({ url: data.url });
        else setGoogleSubmitting(false);
        // Left spinning until either appUrlOpen's code exchange finishes
        // (auth state changes and this screen unmounts) or the effect below
        // notices the browser closed without that happening — there's no
        // other signal for "the user backed out of the Google flow."
      } else {
        const { error } = await supabase.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: OAUTH_REDIRECT_URL },
        });
        if (error) throw error;
      }
    } catch (e) {
      setError(e?.message || "Couldn't start Google sign-in.");
      setGoogleSubmitting(false);
    }
  }

  // Safety net for the native flow: if the user backs out of the system
  // browser (or the redirect never makes it back) without completing sign-
  // in, this is the only signal that the button should stop spinning —
  // successful sign-in unmounts the screen before this would ever fire.
  useEffect(() => {
    if (!IS_NATIVE) return;
    const sub = Browser.addListener("browserFinished", () => setGoogleSubmitting(false));
    return () => {
      sub.then((handle) => handle.remove());
    };
  }, []);

  return (
    <div
      className="h-full flex flex-col justify-center px-7"
      style={{ background: T.ink, paddingTop: "max(40px, env(safe-area-inset-top))", paddingBottom: "max(40px, env(safe-area-inset-bottom))" }}
    >
      <div className="flex flex-col items-center mb-7">
        <RotaMark size={52} />
      </div>

      <span style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-2xl font-semibold mb-1 text-center">
        {mode === "signup" ? "Create your account" : "Welcome back"}
      </span>
      <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-sm mb-7 text-center">
        {mode === "signup" ? "Money, on schedule. Let's get you set up." : "Money, on schedule. Good to see you again."}
      </p>

      {forgotOpen ? (
        <div className="flex flex-col gap-3">
          {forgotSent ? (
            <p className="text-sm text-center" style={{ color: T.ok, fontFamily: FONT_BODY }}>
              Check your email for a link to set a new password.
            </p>
          ) : (
            <>
              <p className="text-xs text-center mb-1" style={{ color: T.muted, fontFamily: FONT_BODY }}>
                Enter the email on your account and we'll send you a link to set a new password.
              </p>
              <div>
                <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
                  Email
                </label>
                <input
                  type="email"
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoCapitalize="none"
                  autoCorrect="off"
                  className="w-full rounded-xl px-3 py-2.5 text-sm"
                  style={{ background: T.ink2, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
                />
              </div>
              {forgotError && (
                <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                  {forgotError}
                </p>
              )}
              <button
                onClick={submitForgotPassword}
                disabled={forgotSubmitting}
                className="w-full rounded-2xl py-3.5 font-semibold text-sm mt-1 transition-transform active:scale-95"
                style={{ background: T.gold, color: T.ink2, fontFamily: FONT_BODY, boxShadow: `0 10px 24px -8px ${T.gold}` }}
              >
                {forgotSubmitting ? "Sending…" : "Send reset link"}
              </button>
            </>
          )}
          <button
            onClick={() => {
              setForgotOpen(false);
              setForgotSent(false);
              setForgotError("");
            }}
            className="w-full text-center mt-1"
            style={{ fontFamily: FONT_BODY }}
          >
            <span className="text-sm font-bold" style={{ color: T.ok }}>
              Back to log in
            </span>
          </button>
        </div>
      ) : checkEmail ? (
        <p className="text-sm text-center" style={{ color: T.ok, fontFamily: FONT_BODY }}>
          Check your email to confirm your account, then log in below.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {mode === "login" && biometricUserId && (
            <>
              <button
                onClick={loginWithBiometric}
                disabled={bioSubmitting}
                className="w-full rounded-2xl py-3 font-semibold text-sm flex items-center justify-center gap-2.5 transition-transform active:scale-95"
                style={{ background: T.gold, color: T.ink2, fontFamily: FONT_BODY, boxShadow: `0 10px 24px -8px ${T.gold}` }}
              >
                <Fingerprint size={18} />
                {bioSubmitting ? "Confirming…" : biometricLabel ? `Log in as ${biometricLabel}` : "Log in with biometrics"}
              </button>
              <div className="flex items-center gap-3 my-1">
                <div className="h-px flex-1" style={{ background: T.ink3 }} />
                <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
                  or
                </span>
                <div className="h-px flex-1" style={{ background: T.ink3 }} />
              </div>
            </>
          )}
          <button
            onClick={signInWithGoogle}
            disabled={googleSubmitting}
            className="w-full rounded-2xl py-3 font-semibold text-sm flex items-center justify-center gap-2.5 transition-transform active:scale-95"
            style={{ background: T.ink2, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
          >
            {googleSubmitting ? (
              <Loader2 size={17} className="animate-spin" />
            ) : (
              <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
                <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.6 6 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z" />
                <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.8 1.1 8 3l5.7-5.7C34.6 6 29.6 4 24 4 16.3 4 9.6 8.3 6.3 14.7z" />
                <path fill="#4CAF50" d="M24 44c5.5 0 10.4-1.9 14.2-5.1l-6.6-5.4C29.6 35.5 26.9 36 24 36c-5.3 0-9.6-3.3-11.3-8l-6.6 5.1C9.5 39.6 16.2 44 24 44z" />
                <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.3 5.7l6.6 5.4C41.5 36 44 30.6 44 24c0-1.3-.1-2.3-.4-3.5z" />
              </svg>
            )}
            {googleSubmitting ? "Opening Google…" : "Continue with Google"}
          </button>

          <div className="flex items-center gap-3 my-1">
            <div className="h-px flex-1" style={{ background: T.ink3 }} />
            <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
              or
            </span>
            <div className="h-px flex-1" style={{ background: T.ink3 }} />
          </div>

          {mode === "login" ? (
            <div>
              <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
                Email or phone number
              </label>
              <input
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="you@example.com or 080..."
                autoCapitalize="none"
                autoCorrect="off"
                className="w-full rounded-xl px-3 py-2.5 text-sm"
                style={{ background: T.ink2, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_MONO }}
              />
            </div>
          ) : (
            <div>
              <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-xl px-3 py-2.5 text-sm"
                style={{ background: T.ink2, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
              />
            </div>
          )}
          <div>
            <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
              Password
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                className="w-full rounded-xl pl-3 pr-10 py-2.5 text-sm"
                style={{ background: T.ink2, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-0 top-0 h-full px-3 flex items-center"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff size={16} color={T.muted} /> : <Eye size={16} color={T.muted} />}
              </button>
            </div>
            {mode === "login" && (
              <button
                type="button"
                onClick={() => {
                  setForgotEmail(identifier.includes("@") ? identifier.trim() : "");
                  setForgotError("");
                  setForgotSent(false);
                  setForgotOpen(true);
                }}
                className="mt-1.5"
              >
                <span className="text-xs font-medium" style={{ color: T.muted, fontFamily: FONT_BODY }}>
                  Forgot password?
                </span>
              </button>
            )}
          </div>
          {error && (
            <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
              {error}
            </p>
          )}
          <button
            onClick={submit}
            disabled={submitting}
            className="w-full rounded-2xl py-3.5 font-semibold text-sm mt-1 transition-transform active:scale-95"
            style={{ background: T.gold, color: T.ink2, fontFamily: FONT_BODY, boxShadow: `0 10px 24px -8px ${T.gold}` }}
          >
            {submitting ? "Please wait..." : mode === "signup" ? "Sign up" : "Log in"}
          </button>
        </div>
      )}

      <button
        onClick={() => {
          setMode(mode === "signup" ? "login" : "signup");
          setError("");
          setCheckEmail(false);
        }}
        className="w-full text-center mt-6"
        style={{ fontFamily: FONT_BODY }}
      >
        <span className="text-sm" style={{ color: T.muted }}>
          {mode === "signup" ? "Already have an account? " : "Don't have an account? "}
        </span>
        <span className="text-sm font-bold" style={{ color: T.ok }}>
          {mode === "signup" ? "Log in" : "Tap here to sign up"}
        </span>
      </button>
    </div>
  );
}

// Shown once a password-recovery link finishes establishing a session (see
// passwordRecovery in RotaApp) — the recovery session is real and already
// signed in, so this only needs to collect + save the new password, not
// re-authenticate.
function ResetPasswordScreen({ onDone }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (submitting) return;
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    setError("");
    const { error: updateErr } = await supabase.auth.updateUser({ password });
    setSubmitting(false);
    if (updateErr) setError(updateErr.message);
    else onDone();
  }

  return (
    <div
      className="h-full flex flex-col justify-center px-7"
      style={{ background: T.ink, paddingTop: "max(40px, env(safe-area-inset-top))", paddingBottom: "max(40px, env(safe-area-inset-bottom))" }}
    >
      <div className="flex flex-col items-center mb-7">
        <RotaMark size={52} />
      </div>
      <span style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-2xl font-semibold mb-1 text-center">
        Set a new password
      </span>
      <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-sm mb-7 text-center">
        Choose a new password for your account.
      </p>
      <div className="flex flex-col gap-3">
        <div>
          <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
            New password
          </label>
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 6 characters"
              className="w-full rounded-xl pl-3 pr-10 py-2.5 text-sm"
              style={{ background: T.ink2, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-0 top-0 h-full px-3 flex items-center"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff size={16} color={T.muted} /> : <Eye size={16} color={T.muted} />}
            </button>
          </div>
        </div>
        <div>
          <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
            Confirm new password
          </label>
          <input
            type={showPassword ? "text" : "password"}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Re-enter your new password"
            className="w-full rounded-xl px-3 py-2.5 text-sm"
            style={{ background: T.ink2, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_BODY }}
          />
        </div>
        {error && (
          <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
            {error}
          </p>
        )}
        <button
          onClick={submit}
          disabled={submitting}
          className="w-full rounded-2xl py-3.5 font-semibold text-sm mt-1 transition-transform active:scale-95"
          style={{ background: T.gold, color: T.ink2, fontFamily: FONT_BODY, boxShadow: `0 10px 24px -8px ${T.gold}` }}
        >
          {submitting ? "Saving…" : "Save new password"}
        </button>
      </div>
    </div>
  );
}

/* ---------- Rota Tap claim ---------- */
// The reusable guts of claiming a Rota Tap — usable both as a full page
// (reachable via ?tap=<token>, works without being signed in) and embedded
// inline inside a sheet right after a QR scan, since within the app the
// user is already authenticated. Accepting never asks for a PIN —
// only the sender authorized anything here. onDone receives the receiver's
// fresh wallet balance so callers can update already-mounted state.
function TapClaimBody({ token, user, onDone }) {
  const [status, setStatus] = useState("loading"); // loading | ready | claiming | claimed | error
  const [info, setInfo] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [claimedAmount, setClaimedAmount] = useState(null);
  const [newBalance, setNewBalance] = useState(null);
  const [showAuth, setShowAuth] = useState(false);

  useEffect(() => {
    let alive = true;
    supabase.functions.invoke("tap-transfer-preview", { body: { token } }).then(({ data }) => {
      if (!alive) return;
      if (!data?.ok) {
        setErrorMsg((data && data.error) || "This link isn't valid.");
        setStatus("error");
        return;
      }
      setInfo(data);
      setStatus("ready");
    });
    return () => {
      alive = false;
    };
  }, [token]);

  async function accept() {
    setStatus("claiming");
    setErrorMsg("");
    const { data, error } = await supabase.functions.invoke("tap-transfer-claim", { body: { token } });
    if (error || !data?.ok) {
      setErrorMsg((data && data.error) || "Couldn't accept this transfer.");
      setStatus("ready");
      return;
    }
    setClaimedAmount(data.amount);
    setNewBalance(data.newBalance);
    setStatus("claimed");
  }

  return (
    <div className="flex flex-col items-center text-center w-full">
      {status === "loading" && (
        <div className="flex justify-center py-6">
          <Loader2 size={22} className="animate-spin" color={T.muted} />
        </div>
      )}

      {status === "error" && (
        <div>
          <p style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold mb-2">
            {errorMsg}
          </p>
          <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-sm">
            Ask them to send a new Rota Tap.
          </p>
        </div>
      )}

      {(status === "ready" || status === "claiming") && info && (
        <div className="flex flex-col items-center gap-4 w-full">
          <div className="rounded-full flex items-center justify-center" style={{ width: 44, height: 44, background: T.gold }}>
            <Wifi size={20} color={T.ink2} style={{ transform: "rotate(90deg)" }} />
          </div>
          <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-sm">
            Incoming transfer from
          </p>
          <p style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-xl font-semibold">
            {info.senderName}
          </p>
          <p style={{ fontFamily: FONT_MONO, color: T.paper }} className="text-3xl font-semibold">
            {naira(info.amount)}
          </p>

          {errorMsg && (
            <p className="text-xs" style={{ color: T.warn, fontFamily: FONT_BODY }}>
              {errorMsg}
            </p>
          )}

          {!user ? (
            showAuth ? (
              <div className="w-full mt-2">
                <AuthScreen />
              </div>
            ) : (
              <button
                onClick={() => setShowAuth(true)}
                className="w-full rounded-2xl py-3.5 font-semibold text-sm mt-1 transition-transform active:scale-95"
                style={{ background: T.gold, color: T.ink2, fontFamily: FONT_BODY }}
              >
                Log in or sign up to accept
              </button>
            )
          ) : (
            <button
              onClick={accept}
              disabled={status === "claiming"}
              className="w-full rounded-2xl py-3.5 font-semibold text-sm mt-1 flex items-center justify-center gap-2 transition-transform active:scale-95"
              style={{ background: T.ok, color: "#fff", fontFamily: FONT_BODY }}
            >
              {status === "claiming" && <Loader2 size={14} className="animate-spin" />}
              Accept
            </button>
          )}
        </div>
      )}

      {status === "claimed" && (
        <div className="flex flex-col items-center gap-3 w-full">
          <div className="rounded-full flex items-center justify-center" style={{ width: 48, height: 48, background: T.ok }}>
            <Check size={24} color="#fff" />
          </div>
          <p style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            {naira(claimedAmount)} added to your wallet
          </p>
          <button
            onClick={() => onDone(newBalance)}
            className="w-full rounded-2xl py-3.5 font-semibold text-sm mt-2 transition-transform active:scale-95"
            style={{ background: T.gold, color: T.ink2, fontFamily: FONT_BODY }}
          >
            Go to Rota
          </button>
        </div>
      )}
    </div>
  );
}

// Page-level wrapper for the ?tap=<token> route — adds the full-height
// centered layout TapClaimBody doesn't need when it's embedded in a sheet.
function TapClaimScreen({ token, user, onDone }) {
  return (
    <div className="h-full flex flex-col justify-center px-7" style={{ background: T.ink, paddingTop: "max(40px, env(safe-area-inset-top))", paddingBottom: "max(40px, env(safe-area-inset-bottom))" }}>
      <TapClaimBody token={token} user={user} onDone={onDone} />
    </div>
  );
}

// Swipe-down-to-refresh for a scrollable container. Tracks the drag with
// refs (not state) so the touchmove listener never needs re-binding
// mid-gesture — only the visible pull distance goes through setState, to
// drive the indicator's height/rotation each frame.
function PullToRefresh({ scrollRef, onRefresh, children }) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const dragging = useRef(false);
  const startY = useRef(null);
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);
  const THRESHOLD = 64;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    function onTouchStart(e) {
      if (el.scrollTop <= 0 && !refreshingRef.current) {
        startY.current = e.touches[0].clientY;
        dragging.current = true;
      }
    }
    function onTouchMove(e) {
      if (!dragging.current || startY.current == null) return;
      const delta = e.touches[0].clientY - startY.current;
      if (delta <= 0 || el.scrollTop > 0) {
        dragging.current = false;
        pullRef.current = 0;
        setPull(0);
        return;
      }
      e.preventDefault();
      const next = Math.min(delta * 0.5, THRESHOLD * 1.4);
      pullRef.current = next;
      setPull(next);
    }
    async function onTouchEnd() {
      if (!dragging.current) return;
      dragging.current = false;
      startY.current = null;
      if (pullRef.current >= THRESHOLD) {
        refreshingRef.current = true;
        setRefreshing(true);
        setPull(THRESHOLD);
        try {
          await onRefresh();
        } finally {
          refreshingRef.current = false;
          setRefreshing(false);
          pullRef.current = 0;
          setPull(0);
        }
      } else {
        pullRef.current = 0;
        setPull(0);
      }
    }

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [scrollRef, onRefresh]);

  const height = refreshing ? THRESHOLD : pull;
  return (
    <>
      <div
        className="flex items-center justify-center overflow-hidden"
        style={{ height, transition: dragging.current ? "none" : "height 200ms ease" }}
      >
        <RotateCcw
          size={18}
          color={T.muted}
          className={refreshing ? "animate-spin" : ""}
          style={refreshing ? undefined : { transform: `rotate(${pull * 3}deg)`, opacity: Math.min(pull / THRESHOLD, 1) }}
        />
      </div>
      {children}
    </>
  );
}

/* ---------- Root ---------- */
export default function RotaApp() {
  const [authLoading, setAuthLoading] = useState(true);
  const [screen, setScreen] = useState("welcome"); // welcome | auth | link | app
  const [tab, setTab] = useState("home");
  const [user, setUser] = useState(null);
  const [payments, setPayments] = useState([]);
  const [todos, setTodos] = useState([]);
  const [settings, setSettings] = useState(defaultSettings());
  // Lives here rather than inside HomeTab so Schedule can read the same
  // schedule_balance/balance figures Home shows, not a second independently
  // fetched copy that could ever disagree.
  const [wallet, setWallet] = useState(null);
  const [walletLoading, setWalletLoading] = useState(true);
  const [walletTxns, setWalletTxns] = useState([]);
  // Native enrollment is device-local (Keystore-bound), unlike WebAuthn's
  // account-level registration — tracked separately so switching devices
  // doesn't inherit a stale "enrolled" state from one that never enrolled.
  const [nativeBioEnrolled, setNativeBioEnrolled] = useState(() => IS_NATIVE && localStorage.getItem(NATIVE_BIO_FLAG_KEY) === "1");
  const hasBiometricConfirm = IS_NATIVE ? nativeBioEnrolled : settings.biometricRegistered;
  const [tapClaimToken, setTapClaimToken] = useState(() => new URLSearchParams(window.location.search).get("tap"));
  // Set once a password-recovery link finishes establishing a session
  // (either via onAuthStateChange's PASSWORD_RECOVERY event on web, or the
  // manual fallback in handleAuthCallbackUrl for native deep links) — takes
  // over the screen so the user actually sets a new password instead of
  // silently landing back in the app on the old one.
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const homeScrollRef = useRef(null);
  const lastBackPressRef = useRef(0);
  const [showExitToast, setShowExitToast] = useState(false);
  const headerRef = useRef(null);
  // Read inside the appStateChange listener below without re-subscribing it
  // on every sign-in/out — the listener itself is only set up once.
  const userRef = useRef(null);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // AppHeader is sticky within the scroll container (rota-header-glass), and
  // Schedule's own stats card sticks right below it — but the header's real
  // height varies per device (safe-area inset), so it's measured here rather
  // than guessed, and exposed as a CSS variable the sticky card's `top` reads.
  useEffect(() => {
    const el = headerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const setVar = () => document.documentElement.style.setProperty("--rota-header-h", `${el.offsetHeight}px`);
    setVar();
    const ro = new ResizeObserver(setVar);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Shared by both listeners below — completes the sign-in from a callback
  // URL. Handled two different-looking ways because Supabase's OAuth
  // callback can come back in either shape depending on flow type: PKCE
  // puts a "code" in the query string (needs a server round trip via
  // exchangeCodeForSession), while implicit flow puts the actual
  // access_token/refresh_token straight in the URL *fragment* (usable
  // directly via setSession, no round trip needed) — confirmed from a live
  // capture that this project's callback actually arrives in the fragment
  // form, which a query-string-only parser silently ignored entirely.
  // Guarded against re-running on the same result twice, since
  // getLaunchUrl() keeps returning the same stale URL on every later
  // resume, not just the one right after the redirect.
  const lastOAuthResultRef = useRef(null);
  const handleAuthCallbackUrl = useCallback((url) => {
    try {
      const u = new URL(url);
      const params = u.searchParams;
      const hashParams = new URLSearchParams(u.hash.replace(/^#/, ""));
      const oauthError =
        params.get("error_description") || params.get("error") || hashParams.get("error_description") || hashParams.get("error");
      if (oauthError) console.error("[RotaAuth] OAuth callback error:", oauthError);

      const type = hashParams.get("type") || params.get("type");

      const accessToken = hashParams.get("access_token");
      const refreshToken = hashParams.get("refresh_token");
      if (accessToken && refreshToken) {
        if (accessToken === lastOAuthResultRef.current) return;
        lastOAuthResultRef.current = accessToken;
        console.log("[RotaAuth] setting session from implicit-flow tokens");
        Browser.close().catch(() => {});
        supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }).then(
          ({ data, error }) => {
            if (error) console.error("[RotaAuth] setSession failed:", error.message, error);
            else {
              console.log("[RotaAuth] setSession succeeded");
              // Manual setSession doesn't fire onAuthStateChange's
              // PASSWORD_RECOVERY event the way detectSessionInUrl does on
              // web, so this is the native fallback for the same signal.
              if (type === "recovery") {
                setPasswordRecovery(true);
                if (data?.session) loadUserData(data.session.user);
              }
            }
          },
          (e) => console.error("[RotaAuth] setSession threw:", e)
        );
        return;
      }

      // Email-action links (recovery, magic link, invite) use this shape
      // rather than implicit-flow hash tokens or a PKCE "code".
      const tokenHash = hashParams.get("token_hash") || params.get("token_hash");
      if (tokenHash && type) {
        if (tokenHash === lastOAuthResultRef.current) return;
        lastOAuthResultRef.current = tokenHash;
        console.log("[RotaAuth] verifying OTP token_hash, type:", type);
        Browser.close().catch(() => {});
        supabase.auth.verifyOtp({ token_hash: tokenHash, type }).then(
          ({ data, error }) => {
            if (error) console.error("[RotaAuth] verifyOtp failed:", error.message, error);
            else {
              console.log("[RotaAuth] verifyOtp succeeded");
              if (type === "recovery") {
                setPasswordRecovery(true);
                if (data?.session) loadUserData(data.session.user);
              }
            }
          },
          (e) => console.error("[RotaAuth] verifyOtp threw:", e)
        );
        return;
      }

      const code = params.get("code");
      if (!code || code === lastOAuthResultRef.current) return;
      lastOAuthResultRef.current = code;
      console.log("[RotaAuth] exchanging code, flowId param:", params.get("sb_flow_id"));
      Browser.close().catch(() => {});
      const flowId = params.get("sb_flow_id") || undefined;
      supabase.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined).then(
        ({ error }) => {
          if (error) console.error("[RotaAuth] exchangeCodeForSession failed:", error.message, error);
          else console.log("[RotaAuth] exchangeCodeForSession succeeded");
        },
        (e) => console.error("[RotaAuth] exchangeCodeForSession threw:", e)
      );
    } catch (e) {
      console.error("[RotaAuth] handleAuthCallbackUrl error:", e);
    }
  }, []);

  // Android hardware/gesture back button does nothing by default without an
  // explicit listener. Priority: close the topmost open sheet/overlay (via
  // the shared rotaBackStack, which cascades correctly for sheets nested
  // inside other sheets, unwinding whatever was opened within the current
  // tab one at a time) → once nothing is open, you're at that tab's own
  // root — back does NOT switch to a different tab from here, it requires a
  // second press within 2s to actually exit, showing a small toast on the
  // first press, the same from every tab.
  useEffect(() => {
    if (!IS_NATIVE) return;
    const sub = CapacitorApp.addListener("backButton", () => {
      if (rotaBackStack.length > 0) {
        const top = rotaBackStack[rotaBackStack.length - 1];
        top();
        return;
      }
      const now = Date.now();
      if (now - lastBackPressRef.current < 2000) {
        CapacitorApp.exitApp();
        return;
      }
      lastBackPressRef.current = now;
      setShowExitToast(true);
      setTimeout(() => setShowExitToast(false), 2000);
    });
    return () => {
      sub.then((handle) => handle.remove());
    };
  }, []);

  // App Links land here instead of a fresh page load, so pick the token
  // out of the launch URL by hand and feed it into the same state the
  // ?tap= query-param path already uses — no separate claim UI needed.
  useEffect(() => {
    if (!IS_NATIVE) return;
    const sub = CapacitorApp.addListener("appUrlOpen", ({ url }) => {
      console.log("[RotaAuth] appUrlOpen:", url);
      try {
        const token = new URL(url).searchParams.get("tap");
        if (token) {
          setTapClaimToken(token);
          return;
        }
      } catch {
        // not a URL we care about
      }
      handleAuthCallbackUrl(url);
    });
    return () => {
      sub.then((handle) => handle.remove());
    };
  }, [handleAuthCallbackUrl]);

  // Fallback for Google sign-in specifically: the browser opened by
  // Browser.open() runs in the *same* task as the app, so Google/Supabase's
  // redirect back to our custom scheme looks to Android like a normal
  // back-navigation to an activity already on the stack, not a fresh
  // intent — onNewIntent() (and therefore appUrlOpen above) never fires.
  // getLaunchUrl() reads the intent directly instead of waiting on that
  // event, so checking it on every resume catches this reliably.
  //
  // (Data-refresh-on-resume lives in a second effect further down, once
  // loadUserData/refreshWallet exist — see the comment there.)
  useEffect(() => {
    if (!IS_NATIVE) return;
    const sub = CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (!isActive) return;
      CapacitorApp.getLaunchUrl()
        .then((result) => {
          if (result?.url) {
            console.log("[RotaAuth] getLaunchUrl on resume:", result.url);
            handleAuthCallbackUrl(result.url);
          }
        })
        .catch(() => {});
    });
    return () => {
      sub.then((handle) => handle.remove());
    };
  }, [handleAuthCallbackUrl]);

  // Open app mode's notification stashes its claim token natively rather
  // than relying solely on the launch intent's own data — appUrlOpen above
  // is built around an already-running app receiving a *new* intent, which
  // isn't the same code path a cold start goes through, and that gap was
  // why "open app" wasn't reliably landing on the Accept screen. Checking
  // once on mount catches it regardless of whether the app was running.
  useEffect(() => {
    if (!IS_NATIVE) return;
    RotaNfcReader.getPendingClaim()
      .then(({ token }) => {
        if (token) setTapClaimToken(token);
      })
      .catch(() => {});
  }, []);


  // Starts this phone passively broadcasting its own receive identity —
  // once started it keeps answering taps natively regardless of what screen
  // is open, whether the app is backgrounded, or fully closed. Only needs
  // starting once; TapSendSheet pauses/restarts it around an active send.
  useEffect(() => {
    if (!IS_NATIVE || !user || !settings.tapReceiveToken) return;
    startReceiveBroadcast(settings.tapReceiveToken);
  }, [user?.id, settings.tapReceiveToken]);

  // Registers this device for push notifications once signed in, so a
  // server-side function can notify this phone about a transaction even
  // while the app is closed. Re-registering on every sign-in is cheap and
  // keeps the stored token fresh if it ever rotates.
  useEffect(() => {
    if (!IS_NATIVE || !user) return;
    let regListener = null;
    let errListener = null;

    PushNotifications.requestPermissions().then(({ receive }) => {
      if (receive !== "granted") return;
      PushNotifications.register();
    });

    PushNotifications.addListener("registration", (token) => {
      supabase
        .from("device_push_tokens")
        .upsert({ user_id: user.id, token: token.value, platform: "android" }, { onConflict: "token" })
        .then(() => {});
    }).then((handle) => {
      regListener = handle;
    });

    PushNotifications.addListener("registrationError", (err) => {
      console.error("Push registration failed", err);
    }).then((handle) => {
      errListener = handle;
    });

    // Android only auto-shows a push as a system notification when the app
    // is backgrounded/closed — while it's open, the OS just hands it to us
    // as a JS event instead, so without this, an in-app push is silently
    // dropped with nothing visible at all.
    let receivedListener = null;
    LocalNotifications.requestPermissions().catch(() => {});
    PushNotifications.addListener("pushNotificationReceived", (notification) => {
      // open_app mode, app already open: just go straight to the Accept
      // screen instead of making them tap a local notification first —
      // there's nothing to auto-open, they're already looking at it.
      if (notification.data?.type === "tap_open_app" && notification.data?.token) {
        setTapClaimToken(notification.data.token);
        return;
      }
      LocalNotifications.schedule({
        notifications: [
          {
            id: Date.now() % 2147483647,
            title: notification.title || "Rota",
            body: notification.body || "",
            smallIcon: "ic_stat_rota",
            largeIcon: "ic_rota_large",
            iconColor: "#0B1120",
          },
        ],
      }).catch(() => {});
    }).then((handle) => {
      receivedListener = handle;
    });

    // open_app mode, app backgrounded/closed: Android auto-displayed the
    // system notification (has a "notification" block, unlike the data-only
    // quick_accept push RotaMessagingService.kt handles natively) — tapping
    // it opens the app, and this is what routes that tap to the Accept
    // screen instead of just landing on whatever was last on screen.
    let actionListener = null;
    PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
      const data = action.notification?.data;
      if (data?.type === "tap_open_app" && data?.token) setTapClaimToken(data.token);
    }).then((handle) => {
      actionListener = handle;
    });

    return () => {
      regListener?.remove();
      errListener?.remove();
      receivedListener?.remove();
      actionListener?.remove();
    };
  }, [user?.id]);

  const setBiometricConfirm = useCallback((v) => {
    if (IS_NATIVE) {
      setNativeBioEnrolled(v);
      if (v) localStorage.setItem(NATIVE_BIO_FLAG_KEY, "1");
      else localStorage.removeItem(NATIVE_BIO_FLAG_KEY);
    } else {
      setSettings((prev) => ({ ...prev, biometricRegistered: v }));
    }
  }, []);

  const loadUserData = useCallback(async (authUser) => {
    const [{ data: profileRow }, { data: paymentRows }, { data: todoRows }] = await Promise.all([
      supabase
        .from("profiles")
        .select("id,name,notifications,biometric,card_linked,card_last4,avatar_url,has_pin,total_balance,dark_mode,card_link_skipped,tap_receive_mode,tap_receive_token,referral_code,phone,phone_verified,nickname,gender,date_of_birth,address")
        .eq("id", authUser.id)
        .single(),
      supabase.from("payments").select("*").eq("user_id", authUser.id).order("date", { ascending: true }),
      supabase.from("todos").select("*").eq("user_id", authUser.id).order("created_at", { ascending: true }),
    ]);
    setUser(authUser);
    setSettings(profileRow ? mapProfile(profileRow) : defaultSettings());
    setPayments((paymentRows || []).map((p) => ({ ...p, amount: Number(p.amount) })));
    setTodos(todoRows || []);
    // Only force the card-link screen the very first time — if the user has
    // already linked a card OR already skipped it once before, go straight
    // in. They can still link a card later from Profile.
    setScreen(profileRow && (profileRow.card_linked || profileRow.card_link_skipped) ? "app" : "link");
    setAuthLoading(false);

    supabase.functions.invoke("webauthn-status", { body: {} }).then(({ data }) => {
      if (data && typeof data.registered === "boolean") {
        setSettings((prev) => ({ ...prev, biometricRegistered: data.registered }));
      }
    });
  }, []);

  // dva-get-or-create-wallet attempts the real Paystack DVA call first and
  // only falls back to a labeled preview account because the business isn't
  // registered yet.
  const loadWalletTxns = useCallback(async (walletId) => {
    const { data } = await supabase
      .from("dva_wallet_transactions")
      .select("*")
      .eq("wallet_id", walletId)
      .order("created_at", { ascending: false })
      .limit(100);
    setWalletTxns(data || []);
  }, []);

  const refreshWallet = useCallback(async () => {
    const { data, error } = await supabase.functions.invoke("dva-get-or-create-wallet", { body: {} });
    if (!error && data?.wallet) {
      setWallet(data.wallet);
      await loadWalletTxns(data.wallet.id);
    }
    setWalletLoading(false);
  }, [loadWalletTxns]);

  useEffect(() => {
    if (!user) return;
    refreshWallet();
    // Only re-run when the signed-in user actually changes — refreshWallet
    // itself is called directly wherever a fresher read is needed (pull to
    // refresh, right after a funded Rota moves money).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Payments, todos, and the wallet were previously only ever fetched once,
  // at sign-in — a Capacitor app isn't killed when backgrounded, so
  // reopening it after any real gap just kept showing whatever was fetched
  // at that one sign-in, however old, which is what looked like Schedule
  // "not loading" or being slow. Refetching on every resume keeps it current.
  useEffect(() => {
    if (!IS_NATIVE) return;
    const sub = CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (!isActive || !userRef.current) return;
      loadUserData(userRef.current);
      refreshWallet();
    });
    return () => {
      sub.then((handle) => handle.remove());
    };
  }, [loadUserData, refreshWallet]);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      if (data.session) {
        loadUserData(data.session.user);
        syncNativeSession(data.session);
      } else {
        setScreen("welcome");
        setAuthLoading(false);
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        setPasswordRecovery(true);
        if (session) loadUserData(session.user);
      } else if (event === "SIGNED_IN" && session) {
        loadUserData(session.user);
      } else if (event === "SIGNED_OUT") {
        setUser(null);
        setSettings(defaultSettings());
        setPayments([]);
        setTodos([]);
        setWallet(null);
        setWalletTxns([]);
        setWalletLoading(true);
        setScreen("welcome");
        // RotaApp doesn't remount on sign-out, so tab would otherwise still
        // be wherever it was left (often "profile", since that's where the
        // log-out button lives) the next time someone signs back in.
        setTab("home");
        if (IS_NATIVE) RotaNfcReader.clearSession().catch(() => {});
      }
      // Covers SIGNED_IN, TOKEN_REFRESHED, INITIAL_SESSION, USER_UPDATED —
      // native code (background/closed-app taps) needs whatever the
      // current, freshest token pair is, not just the one from sign-in.
      if (session) syncNativeSession(session);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [loadUserData]);

  const updateSettings = useCallback(
    (partial) => {
      setSettings((prev) => ({ ...prev, ...partial }));
      if (!user) return;
      supabase
        .from("profiles")
        .update(unmapSettings(partial))
        .eq("id", user.id)
        .then(({ error }) => {
          if (error) console.error("Profile update failed", error);
        });
    },
    [user]
  );

  const uploadAvatar = useCallback(
    async (file) => {
      if (!user) return { ok: false, message: "You need to be signed in." };
      try {
        // Re-encode to JPEG client-side first — shrinks large camera photos
        // and normalizes odd source formats before we ever send anything.
        let blob = file;
        try {
          const bitmap = await createImageBitmap(file);
          const maxDim = 512;
          const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(bitmap.width * scale);
          canvas.height = Math.round(bitmap.height * scale);
          const ctx = canvas.getContext("2d");
          ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), "image/jpeg", 0.85));
        } catch {
          // Couldn't decode client-side — fall back to sending the original file.
        }

        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("Could not read that file"));
          reader.readAsDataURL(blob);
        });
        const base64 = dataUrl.split(",")[1];
        const contentType = blob.type || file.type || "image/jpeg";

        // Upload via a server-side function (using the service role) rather than
        // directly from the browser to Storage — sidesteps a storage RLS issue
        // that was silently rejecting every direct client upload.
        const { data, error } = await supabase.functions.invoke("upload-avatar", {
          body: { image_base64: base64, content_type: contentType },
        });
        if (error || !data?.success) {
          return { ok: false, message: (data && data.error) || "Upload failed" };
        }
        setSettings((prev) => ({ ...prev, avatarUrl: data.avatarUrl }));
        return { ok: true };
      } catch (e) {
        console.error("Avatar upload failed", e);
        return { ok: false, message: e?.message || "Upload failed" };
      }
    },
    [user]
  );

  const addPayment = useCallback(
    async (p) => {
      if (!user) return;
      const { data, error } = await supabase
        .from("payments")
        .insert({
          user_id: user.id,
          name: p.name,
          amount: p.amount,
          date: p.date,
          scheduled_time: p.scheduled_time || "09:00:00",
          category: p.category,
          status: "upcoming",
          rota_type: p.rota_type || "manual",
          recipient_bank_code: p.recipient_bank_code || null,
          recipient_bank_name: p.recipient_bank_name || null,
          recipient_account_number: p.recipient_account_number || null,
          recipient_account_name: p.recipient_account_name || null,
        })
        .select()
        .single();
      if (error) {
        console.error("Add payment failed", error);
        return;
      }
      setPayments((prev) => [...prev, { ...data, amount: Number(data.amount) }]);
    },
    [user]
  );
  // Tops up Schedule Balance — either an internal move from Home's balance
  // or a real card charge straight into it — see schedule-fund. Returns
  // { ok } so ScheduleTab can show a failure inline.
  const fundSchedule = useCallback(async (source, amount) => {
    const { data, error } = await supabase.functions.invoke("schedule-fund", { body: { source, amount } });
    if (error || !data?.ok) {
      return { ok: false, error: (data && data.error) || "Couldn't fund Schedule Balance." };
    }
    setWallet((prev) => (prev ? { ...prev, balance: data.balance, schedule_balance: data.scheduleBalance } : prev));
    return { ok: true };
  }, []);
  // "Execute" pays the recipient out of Schedule Balance — see
  // payments-mark-paid. recipient is only needed the first time a Manual
  // Rota (created without one) is executed. Returns { ok } so ScheduleTab
  // can show the failure inline and let the user retry.
  const markPaymentPaid = useCallback(async (id, recipient) => {
    const { data, error } = await supabase.functions.invoke("payments-mark-paid", {
      body: { paymentId: id, ...(recipient || {}) },
    });
    if (error || !data?.ok) {
      const message = (data && data.error) || "Couldn't complete this payout.";
      setPayments((prev) => prev.map((p) => (p.id === id ? { ...p, charge_error: message } : p)));
      return { ok: false, error: message };
    }
    setPayments((prev) => prev.map((p) => (p.id === id ? data.payment : p)));
    setWallet((prev) => (prev ? { ...prev, schedule_balance: data.scheduleBalance } : prev));
    return { ok: true };
  }, []);
  const editPayment = useCallback((id, updates) => {
    setPayments((prev) => prev.map((p) => (p.id === id ? { ...p, ...updates } : p)));
    supabase
      .from("payments")
      .update(updates)
      .eq("id", id)
      .then(({ error }) => {
        if (error) console.error("Edit payment failed", error);
      });
  }, []);
  const deletePayment = useCallback((id) => {
    setPayments((prev) => prev.filter((p) => p.id !== id));
    supabase
      .from("payments")
      .delete()
      .eq("id", id)
      .then(({ error }) => {
        if (error) console.error("Delete payment failed", error);
      });
  }, []);
  const retryPayment = useCallback((id) => {
    setPayments((prev) => prev.map((p) => (p.id === id ? { ...p, status: "upcoming", charge_error: null } : p)));
    supabase
      .from("payments")
      .update({ status: "upcoming", charge_error: null })
      .eq("id", id)
      .then(({ error }) => {
        if (error) console.error("Retry payment failed", error);
      });
  }, []);

  const addTodo = useCallback(
    async (text) => {
      if (!user) return false;
      const { data, error } = await supabase
        .from("todos")
        .insert({ user_id: user.id, text, done: false })
        .select()
        .single();
      if (error) {
        console.error("Add todo failed", error);
        return false;
      }
      setTodos((prev) => [...prev, data]);
      return true;
    },
    [user]
  );
  const toggleTodo = useCallback(
    (id) => {
      const current = todos.find((t) => t.id === id);
      const nextDone = current ? !current.done : true;
      setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, done: nextDone } : t)));
      supabase
        .from("todos")
        .update({ done: nextDone })
        .eq("id", id)
        .then(({ error }) => {
          if (error) console.error("Toggle todo failed", error);
        });
    },
    [todos]
  );
  const deleteTodo = useCallback((id) => {
    setTodos((prev) => prev.filter((t) => t.id !== id));
    supabase
      .from("todos")
      .delete()
      .eq("id", id)
      .then(({ error }) => {
        if (error) console.error("Delete todo failed", error);
      });
  }, []);

  function handleLinked(last4) {
    setSettings((prev) => ({ ...prev, cardLinked: true, cardLast4: last4 }));
    setScreen("app");
    setTab("home");
  }
  function handleCardLinkedFromProfile(last4) {
    // Same server-side effect as handleLinked (verify-card-link already
    // updated the profiles row) — just sync local state, no navigation.
    setSettings((prev) => ({ ...prev, cardLinked: true, cardLast4: last4 }));
  }
  function handleSkipLink() {
    updateSettings({ cardLinkSkipped: true });
    setScreen("app");
    setTab("home");
  }
  async function handleUnlink() {
    if (!user) return;
    await supabase.from("payment_methods").delete().eq("user_id", user.id);
    await supabase.from("profiles").update({ card_linked: false, card_last4: null }).eq("id", user.id);
    setSettings((prev) => ({ ...prev, cardLinked: false, cardLast4: null }));
    setScreen("link");
  }
  async function handleLogout() {
    await supabase.auth.signOut();
  }
  async function handleReset() {
    if (!user) return;
    await supabase.from("payments").delete().eq("user_id", user.id);
    await supabase.from("todos").delete().eq("user_id", user.id);
    setPayments([]);
    setTodos([]);
  }

  // Mutates the shared T palette in place before rendering, so every
  // component's T.xxx reads below pick up the right theme this pass.
  applyTheme(settings.darkMode);

  const globalStyles = `
    @import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Nunito:wght@400;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
    html, body { overscroll-behavior-y: none; }
    .rota-shell {
      height: 100vh;
      height: 100dvh;
      overscroll-behavior: contain;
    }
    /* The logged-in shell is a fixed-height flex column pinned to the
       viewport: the header and tab bar never scroll, only the tab content
       between them does. Previously the outer wrapper was minHeight:100vh
       and the page itself scrolled, carrying the bottom tab bar up off
       the screen on mobile. */
    .rota-viewport {
      height: 100vh;
      height: 100dvh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .rota-shell-app {
      flex: 1;
      min-height: 0;
      overscroll-behavior: contain;
    }
    .rota-tabbar-safe {
      padding-bottom: max(14px, env(safe-area-inset-bottom));
    }
    /* The bottom bar is fixed to the viewport, so it no longer takes up
       flow space — reserve that space at the end of the scroll area
       instead, or the last card sits underneath it. */
    .rota-scroll-pad {
      padding-bottom: calc(72px + max(14px, env(safe-area-inset-bottom)));
    }
    @media (min-width: 1024px) {
      .rota-scroll-pad { padding-bottom: 0; }
    }
    .rota-header-safe {
      padding-top: max(24px, env(safe-area-inset-top));
    }
    /* Sticks to the top of the scroll container it lives in (not the
       viewport) so tab content scrolls up and passes visibly behind its
       blur, iOS-style, instead of the header just sitting in normal flow
       and pushing content down. */
    .rota-header-glass {
      position: sticky;
      top: 0;
      z-index: 10;
    }
    /* Stacks directly below rota-header-glass in the same scroll container —
       --rota-header-h is measured off the real header (its height varies by
       device safe-area) rather than a guessed constant. */
    .rota-sticky-card {
      position: sticky;
      top: var(--rota-header-h, 64px);
      z-index: 9;
    }
  `;

  if (tapClaimToken) {
    return (
      <div className="w-full flex justify-center" style={{ background: T.ink3, minHeight: "100vh" }}>
        <style>{globalStyles}</style>
        <div
          className="rota-shell w-full sm:max-w-lg relative overflow-hidden"
          style={{ background: T.ink, borderLeft: `1px solid ${T.ink3}`, borderRight: `1px solid ${T.ink3}` }}
        >
          <TapClaimScreen
            token={tapClaimToken}
            user={user}
            onDone={() => {
              window.history.replaceState(null, "", "/");
              setTapClaimToken(null);
            }}
          />
        </div>
      </div>
    );
  }

  if (passwordRecovery) {
    return (
      <div className="w-full flex justify-center" style={{ background: T.ink3, minHeight: "100vh" }}>
        <style>{globalStyles}</style>
        <div
          className="rota-shell w-full sm:max-w-lg relative overflow-hidden"
          style={{ background: T.ink, borderLeft: `1px solid ${T.ink3}`, borderRight: `1px solid ${T.ink3}` }}
        >
          <ResetPasswordScreen onDone={() => setPasswordRecovery(false)} />
        </div>
      </div>
    );
  }

  const isAppScreen = !authLoading && screen === "app";

  if (!isAppScreen) {
    // Onboarding / auth screens stay a narrow, centered column at every
    // width — this is a login-style flow, not a dashboard, so it shouldn't
    // stretch edge-to-edge on a laptop any more than a normal sign-in page would.
    const bodyStyle = { background: T.ink, height: "100%", display: "flex", flexDirection: "column" };
    return (
      <div className="w-full flex justify-center" style={{ background: T.ink3, minHeight: "100vh" }}>
        <style>{globalStyles}</style>
        <div
          className="rota-shell w-full sm:max-w-lg relative overflow-hidden"
          style={{ background: T.ink, borderLeft: `1px solid ${T.ink3}`, borderRight: `1px solid ${T.ink3}` }}
        >
          {authLoading ? (
            <div className="h-full flex items-center justify-center" style={bodyStyle}>
              <span style={{ fontFamily: FONT_DISPLAY, color: T.gold }} className="text-xl">
                Rota
              </span>
            </div>
          ) : screen === "welcome" ? (
            <WelcomeScreen onNext={() => setScreen("auth")} />
          ) : screen === "auth" ? (
            <AuthScreen />
          ) : (
            <LinkScreen email={user?.email} onLinked={handleLinked} onSkip={handleSkipLink} />
          )}
        </div>
      </div>
    );
  }

  // The logged-in app fills the full browser width. Below the lg breakpoint
  // it's the familiar single-column mobile layout with a bottom tab bar;
  // from lg up, a sidebar takes over navigation and the freed-up horizontal
  // space goes to actual chrome (sidebar, full-width header) instead of
  // empty margin — the content column itself stays at a readable width.
  return (
    <div className="rota-viewport w-full" style={{ background: T.ink }}>
      <style>{globalStyles}</style>
      <div className="rota-shell-app w-full flex overflow-hidden">
        <SideNav tab={tab} setTab={setTab} />
        <div className="relative flex-1 flex flex-col min-w-0">
          <div className="flex-1 overflow-y-auto rota-scroll-pad" ref={homeScrollRef}>
            <AppHeader
              title={{ home: "Rota", schedule: "Schedule", todo: "To-Do", advisor: "Advisor", profile: "Profile" }[tab]}
              onProfile={() => setTab("profile")}
              showAvatar={tab === "home"}
              avatarUrl={settings.avatarUrl}
              name={settings.name}
              headerRef={headerRef}
            />
            <div className="max-w-2xl mx-auto w-full">
              {tab === "home" && (
                <PullToRefresh
                  scrollRef={homeScrollRef}
                  onRefresh={() => Promise.all([loadUserData(user), refreshWallet()])}
                >
                  <HomeTab
                    payments={payments}
                    settings={settings}
                    goTab={setTab}
                    onUpdate={updateSettings}
                    user={user}
                    hasBiometricConfirm={hasBiometricConfirm}
                    wallet={wallet}
                    walletLoading={walletLoading}
                    walletTxns={walletTxns}
                    onWalletChange={setWallet}
                    onReloadWalletTxns={loadWalletTxns}
                  />
                </PullToRefresh>
              )}
              {tab === "schedule" && (
                <PullToRefresh
                  scrollRef={homeScrollRef}
                  onRefresh={() => Promise.all([loadUserData(user), refreshWallet()])}
                >
                  <ScheduleTab
                    payments={payments}
                    onAdd={addPayment}
                    onMarkPaid={markPaymentPaid}
                    onEdit={editPayment}
                    onDelete={deletePayment}
                    onRetry={retryPayment}
                    onFundSchedule={fundSchedule}
                    onRefresh={() => Promise.all([loadUserData(user), refreshWallet()])}
                    senderName={settings.name}
                    hasPin={settings.hasPin}
                    hasBiometric={hasBiometricConfirm}
                    wallet={wallet}
                  />
                </PullToRefresh>
              )}
              {tab === "todo" && <TodoTab todos={todos} onAdd={addTodo} onToggle={toggleTodo} onDelete={deleteTodo} />}
              {tab === "advisor" && <AdvisorTab />}
              {tab === "profile" && (
                <ProfileTab
                  settings={settings}
                  onUpdate={updateSettings}
                  onLogout={handleLogout}
                  onReset={handleReset}
                  onUnlink={handleUnlink}
                  onUploadAvatar={uploadAvatar}
                  onBiometricChange={setBiometricConfirm}
                  hasBiometricConfirm={hasBiometricConfirm}
                  email={user?.email}
                  onCardLinked={handleCardLinkedFromProfile}
                  accountNumber={wallet?.virtual_account_number}
                />
              )}
            </div>
          </div>
          <TabBar tab={tab} setTab={setTab} />
          {showExitToast && (
            <div
              className="absolute left-1/2 flex items-center gap-2.5 rounded-full py-2.5 px-4"
              style={{
                bottom: 84,
                transform: "translateX(-50%)",
                background: T.ink2,
                border: `1px solid ${T.ink3}`,
                boxShadow: "0 10px 30px -8px rgba(0,0,0,0.5)",
                zIndex: 40,
              }}
            >
              <RotaMark size={18} />
              <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-xs font-medium whitespace-nowrap">
                Tap back again to close Rota
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
