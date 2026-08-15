import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabaseClient.js";
import { startRegistration, startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { NativeBiometric } from "capacitor-native-biometric";
import { HCECapacitorPlugin } from "capacitor-hce-plugin";
import { App as CapacitorApp } from "@capacitor/app";
import { PushNotifications } from "@capacitor/push-notifications";
import QRCode from "qrcode";
import jsQR from "jsqr";
import RotaMark from "./components/RotaMark.jsx";
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
const IS_NATIVE = Capacitor.isNativePlatform();
// Native-only local plugin (android/app/.../RotaNfcReaderPlugin.kt) — the
// "listen for a tap" half capacitor-hce-plugin doesn't provide.
const RotaNfcReader = registerPlugin("RotaNfcReader");

const FONT_DISPLAY = "'Fredoka', 'Baloo 2', system-ui, sans-serif";
const FONT_BODY = "'Nunito', system-ui, -apple-system, sans-serif";
const FONT_MONO = "'IBM Plex Mono', ui-monospace, Menlo, monospace";

const CATEGORIES = ["Housing", "Utilities", "Entertainment", "Savings", "Transport", "Other"];
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
  return out;
}

// Custom "dotted" QR renderer — the default qrcode-package canvas output is
// flat black-and-white squares; this redraws the same matrix as rounded
// body dots with ring-and-dot finder markers instead, matching Rota's UI.
// Cached so repeated receipt generation doesn't re-fetch the icon each time.
let _logoImagePromise = null;
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
          <video ref={videoRef} muted playsInline className="w-full h-full" style={{ objectFit: "cover" }} />
          <div
            className="absolute inset-6 rounded-2xl pointer-events-none"
            style={{ border: `2px solid ${T.gold}`, opacity: 0.7 }}
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
function AppHeader({ title, onProfile, avatarUrl, name }) {
  return (
    <div className="rota-header-safe flex items-center justify-between px-5 pb-3">
      <h1 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-2xl font-semibold">
        {title}
      </h1>
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
  const [method, setMethod] = useState(null); // null = method list
  const [copied, setCopied] = useState(false);
  const [prefillBank, setPrefillBank] = useState("");
  const [qrTab, setQrTab] = useState("mine"); // mine | scan
  const qrCanvasRef = useRef(null);
  const kbInset = useKeyboardInset();

  useEffect(() => {
    if (method === "qr" && qrTab === "mine" && qrCanvasRef.current) {
      drawStyledQR(qrCanvasRef.current, wallet.virtual_account_number, { size: 160, fg: T.paper, bg: T.ink2 });
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
                <div className="rounded-2xl p-6 flex flex-col items-center gap-3" style={{ background: T.ink, border: `1px solid ${T.ink3}` }}>
                  <div className="rounded-xl overflow-hidden" style={{ width: 160, height: 160 }}>
                    <canvas ref={qrCanvasRef} />
                  </div>
                  <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs text-center">
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
// on the server. Nothing moves until the other person scans the QR code and
// accepts — deliberately camera-only, not NFC: Web NFC can only read/write
// passive tags, never exchange data with another active phone, so there's
// no browser API that could make a real phone-to-phone tap work here.
// Camera + QR works identically on a phone or a laptop webcam instead.
// Money debits from the sender only once the receiver taps Accept.
function TapSendSheet({ wallet, hasPin, hasBiometric, onBack, onClose, onClaimed }) {
  const [step, setStep] = useState("amount"); // amount | confirm | ready | claimed
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [transfer, setTransfer] = useState(null); // { id, token, claimUrl }
  const [claimedBy, setClaimedBy] = useState(null); // { name, avatarUrl }
  const [hceStatus, setHceStatus] = useState(null); // null | "unsupported" | "active" | "tapped"
  const canvasRef = useRef(null);
  const pollRef = useRef(null);

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

  useEffect(() => {
    if (step !== "ready" || !transfer) return;
    if (canvasRef.current) {
      drawStyledQR(canvasRef.current, transfer.claimUrl, { size: 176, fg: "#FFFFFF", bg: T.ink });
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

    // Emulate the same claim URL as an NFC tag, alongside the QR code —
    // any phone that taps ours gets the normal "open this link?" system
    // prompt, no app required on their end. QR still works either way.
    let hceListener = null;
    if (IS_NATIVE) {
      // This device can't be a reader and a card at the same time —
      // pause our own tap-listening while we're the one being tapped.
      RotaNfcReader.stopListening().catch(() => {});
      HCECapacitorPlugin.isNfcHceSupported()
        .then(({ supported }) => {
          if (!supported) {
            setHceStatus("unsupported");
            return;
          }
          return HCECapacitorPlugin.startNfcHce({
            content: transfer.claimUrl,
            mimeType: "RTD_URI",
            persistMessage: false,
          }).then(() => setHceStatus("active"));
        })
        .catch(() => setHceStatus("unsupported"));

      HCECapacitorPlugin.addListener("onStatusChanged", ({ eventName }) => {
        if (eventName === "scan-completed") setHceStatus("tapped");
        else if (eventName === "card-emulator-started") setHceStatus("active");
      }).then((handle) => {
        hceListener = handle;
      });
    }

    return () => {
      clearInterval(pollRef.current);
      if (IS_NATIVE) {
        HCECapacitorPlugin.stopNfcHce().catch(() => {});
        RotaNfcReader.startListening().catch(() => {});
        hceListener?.remove();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, transfer]);

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

            <div className="rounded-2xl p-4" style={{ background: T.ink, border: `1px solid ${T.ink3}` }}>
              <canvas ref={canvasRef} />
            </div>
            {hceStatus === "active" || hceStatus === "tapped" ? (
              <p className="text-xs flex items-center gap-1.5 justify-center" style={{ color: T.ok, fontFamily: FONT_BODY }}>
                <Wifi size={13} style={{ transform: "rotate(90deg)" }} />
                {hceStatus === "tapped" ? "Tapped! Waiting for them to accept…" : "Hold the backs of your phones together, or have them scan the QR code."}
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
function HomeTab({ payments, settings, goTab, onUpdate, user, hasBiometricConfirm }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [wallet, setWallet] = useState(null);
  const [walletLoading, setWalletLoading] = useState(true);
  const [walletTxns, setWalletTxns] = useState([]);
  const [addMoneyOpen, setAddMoneyOpen] = useState(false);
  const [sendMoneyOpen, setSendMoneyOpen] = useState(false);
  const [tapMode, setTapMode] = useState(null); // null | choose | send | receive
  const [walletHistoryOpen, setWalletHistoryOpen] = useState(false);
  const [balanceHidden, setBalanceHidden] = useState(false);
  const [walletReceiptFor, setWalletReceiptFor] = useState(null);

  const failedCount = payments.filter((p) => p.status === "failed").length;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  // Wallet balance/activity now live here on Home rather than a separate
  // tab — dva-get-or-create-wallet attempts the real Paystack DVA call
  // first and only falls back to a labeled preview account because the
  // business isn't registered yet.
  const loadWalletTxns = useCallback(async (walletId) => {
    const { data } = await supabase
      .from("dva_wallet_transactions")
      .select("*")
      .eq("wallet_id", walletId)
      .order("created_at", { ascending: false })
      .limit(100);
    setWalletTxns(data || []);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase.functions.invoke("dva-get-or-create-wallet", { body: {} });
      if (!alive) return;
      if (!error && data?.wallet) {
        setWallet(data.wallet);
        loadWalletTxns(data.wallet.id);
      }
      setWalletLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [loadWalletTxns]);

  function refreshWalletBalance(newBalance) {
    setWallet((prev) => (prev ? { ...prev, balance: newBalance } : prev));
    if (wallet) loadWalletTxns(wallet.id);
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

      <div className="flex gap-3">
        <button
          onClick={() => goTab("schedule")}
          className="flex-1 rounded-2xl py-3 flex flex-col items-center gap-1.5 transition-transform active:scale-95"
          style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}
        >
          <Plus size={16} color={T.gold} />
          <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-xs">
            Schedule payment
          </span>
        </button>
        <button
          onClick={() => goTab("todo")}
          className="flex-1 rounded-2xl py-3 flex flex-col items-center gap-1.5 transition-transform active:scale-95"
          style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}
        >
          <CheckSquare size={16} color={T.gold} />
          <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-xs">
            To-do list
          </span>
        </button>
        <button
          onClick={() => setHistoryOpen(true)}
          className="flex-1 rounded-2xl py-3 flex flex-col items-center gap-1.5 transition-transform active:scale-95"
          style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}
        >
          <Receipt size={16} color={T.gold} />
          <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-xs">
            Transactions
          </span>
        </button>
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
    </div>
  );
}

// Money in and money out, grouped by day — so "what did I do today" is the
// first thing visible, with older days below rather than in a separate view.
function WalletHistorySheet({ transactions, onClose, onSelect }) {
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
function ScheduleTab({ payments, onAdd, onEdit, onMarkPaid, onUnmarkPaid, onDelete, onRetry, senderName, hasPin, hasBiometric, totalBalance }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [receiptFor, setReceiptFor] = useState(null);
  const [detailFor, setDetailFor] = useState(null);
  const [detailEditIntent, setDetailEditIntent] = useState(false);
  const sorted = [...payments].sort((a, b) => a.date.localeCompare(b.date));
  const today = todayISO();
  const totalBudgeted = payments.reduce((s, p) => s + p.amount, 0);
  const totalPaid = payments.filter((p) => p.status === "paid").reduce((s, p) => s + p.amount, 0);
  const pct = totalBudgeted ? Math.min(100, Math.round((totalPaid / totalBudgeted) * 100)) : 0;
  const recentPaid = payments
    .filter((p) => p.status === "paid")
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 3);

  return (
    <div className="px-5 pb-4">
      <div className="flex items-center justify-start mb-4">
        <button
          onClick={() => setSheetOpen(true)}
          className="rounded-full flex items-center justify-center transition-transform active:scale-90 flex-shrink-0"
          style={{ width: 40, height: 40, background: T.gold, boxShadow: `0 6px 16px -6px ${T.gold}` }}
        >
          <Plus size={19} color={T.ink2} />
        </button>
      </div>

      {payments.length > 0 && (
        <div className="rounded-2xl p-4 mb-4" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
          <div className="flex justify-between items-baseline mb-3">
            <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
              This month
            </span>
            <span style={{ fontFamily: FONT_MONO, color: T.paper }} className="text-xs">
              {naira(totalPaid)} / {naira(totalBudgeted)}
            </span>
          </div>
          <div className="rounded-full overflow-hidden mb-1" style={{ height: 8, background: T.ink3 }}>
            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: T.gold }} />
          </div>
          <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
            {pct}% of this month's schedule paid out
          </span>
        </div>
      )}

      {recentPaid.length > 0 && (
        <div className="mb-4">
          <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs mb-2">
            Schedule activity
          </p>
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
                {p.status === "failed" && p.charge_error && (
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
                      {!isAutomatic && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onUnmarkPaid(p.id); }}
                          className="text-xs font-medium"
                          style={{ color: T.muted, fontFamily: FONT_BODY }}
                        >
                          Unmark
                        </button>
                      )}
                    </div>
                  ) : p.status === "failed" ? (
                    <button onClick={(e) => { e.stopPropagation(); onRetry(p.id); }} className="text-xs font-medium" style={{ color: T.warn, fontFamily: FONT_BODY }}>
                      {isAutomatic ? "Transfer failed — Retry" : "Charge failed — Retry"}
                    </button>
                  ) : isAutomatic ? (
                    <span className="flex items-center gap-1 text-xs" style={{ color: T.blue, fontFamily: FONT_BODY }}>
                      <Clock size={11} /> Runs automatically
                    </span>
                  ) : (
                    <button onClick={(e) => { e.stopPropagation(); onMarkPaid(p.id); }} className="text-xs font-medium" style={{ color: T.gold, fontFamily: FONT_BODY }}>
                      Mark as paid
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
          totalBalance={totalBalance}
          currentlyScheduled={payments.reduce((s, p) => s + p.amount, 0)}
        />
      )}
      {receiptFor && <ReceiptSheet payment={receiptFor} senderName={senderName} onClose={() => setReceiptFor(null)} />}
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

let cachedBanks = null;

function ScheduleDetailSheet({ payment, onClose, onSave, startEditing = false }) {
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

function AddPaymentSheet({ onClose, onSave, hasPin, hasBiometric, totalBalance, currentlyScheduled }) {
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
  const wouldExceedBalance = totalBalance > 0 && projectedTotal > totalBalance;

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
                ? "Rota charges your card and sends the money to the account below on the due date, automatically."
                : "Rota reminds you on the due date. You send the money yourself, then mark it paid."}
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
              This would put your scheduled Rotas {naira(projectedTotal - totalBalance)} over your total balance.
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
function ReceiptSheet({ payment, senderName, onClose }) {
  const [shareState, setShareState] = useState("idle"); // idle | generating | copied
  const [imgError, setImgError] = useState("");

  const rows = [
    ["Amount", naira(payment.amount)],
    ["From", senderName],
    payment.recipient_account_name ? ["To", payment.recipient_account_name] : null,
    payment.recipient_account_number
      ? ["Account", `${payment.recipient_account_number} · ${payment.recipient_bank_name || "—"}`]
      : null,
    ["For", `${payment.name} (${payment.category})`],
    ["Type", payment.rota_type === "automatic" ? "Automatic Rota" : "Manual Rota"],
    ["Date", payment.paid_at ? new Date(payment.paid_at).toLocaleString("en-NG") : payment.date],
    ["Reference", payment.transaction_ref || "—"],
  ].filter(Boolean);
  const listRows = rows.filter(([label]) => label !== "Amount");

  // Draws a branded receipt card to an offscreen canvas and returns it as a PNG blob —
  // this is the actual "shareable image" (like OPay/Kuda's receipt cards), not just text.
  async function buildReceiptImage() {
    await document.fonts.ready.catch(() => {});
    const W = 720;
    const rowH = 54;
    const H = 400 + listRows.length * rowH;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#FBF8F2";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#8B5CF6";
    ctx.fillRect(0, 0, W, 12);

    let y = 74;
    const logo = await loadLogoImage();
    if (logo) {
      ctx.drawImage(logo, 48, y - 38, 40, 40);
      ctx.fillStyle = "#2E2A22";
      ctx.font = "600 30px Fredoka, sans-serif";
      ctx.fillText("rota", 48 + 40 + 14, y);
    } else {
      ctx.fillStyle = "#2E2A22";
      ctx.font = "600 32px Fredoka, sans-serif";
      ctx.fillText("rota", 48, y);
    }

    y += 34;
    ctx.fillStyle = "#9C927F";
    ctx.font = "600 15px Nunito, sans-serif";
    ctx.fillText("PAYMENT SUCCESSFUL", 48, y);

    y += 72;
    ctx.fillStyle = "#2E2A22";
    ctx.font = "600 50px 'IBM Plex Mono', monospace";
    ctx.fillText(naira(payment.amount), 48, y);

    y += 38;
    ctx.strokeStyle = "#EDE4D3";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(48, y);
    ctx.lineTo(W - 48, y);
    ctx.stroke();

    y += 44;
    for (const [label, value] of listRows) {
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

    y += 6;
    ctx.strokeStyle = "#EDE4D3";
    ctx.beginPath();
    ctx.moveTo(48, y);
    ctx.lineTo(W - 48, y);
    ctx.stroke();

    y += 42;
    ctx.fillStyle = "#9C927F";
    ctx.font = "italic 14px Nunito, sans-serif";
    ctx.fillText("Money, on schedule. — Rota", 48, y);

    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png", 0.95));
  }

  async function shareImage() {
    setShareState("generating");
    setImgError("");
    try {
      const blob = await buildReceiptImage();
      if (!blob) throw new Error("Could not render image");
      const file = new File([blob], `rota-receipt-${payment.id || Date.now()}.png`, { type: "image/png" });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "Rota receipt" });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
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
    const text = [`Rota payment receipt`, ...rows.map(([l, v]) => `${l}: ${v}`)].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setShareState("copied");
      setTimeout(() => setShareState("idle"), 1500);
    } catch {
      // clipboard unavailable — no-op
    }
  }

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 25 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            Receipt
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>

        <div className="rounded-2xl p-4 mb-4" style={{ background: T.ink, border: `1px solid ${T.ink3}` }}>
          <div className="flex items-center gap-2 mb-3">
            <div className="rounded-full flex items-center justify-center" style={{ width: 30, height: 30, background: T.ok }}>
              <Check size={16} color={T.ink} />
            </div>
            <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm font-medium">
              Payment successful
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <ReceiptRow label="Amount" value={naira(payment.amount)} mono />
            <ReceiptRow label="From" value={senderName} />
            {payment.recipient_account_name && <ReceiptRow label="To" value={payment.recipient_account_name} />}
            {payment.recipient_account_number && (
              <ReceiptRow label="Account" value={`${payment.recipient_account_number} · ${payment.recipient_bank_name || "—"}`} mono />
            )}
            <ReceiptRow label="For" value={`${payment.name} (${payment.category})`} />
            <ReceiptRow label="Type" value={payment.rota_type === "automatic" ? "Automatic Rota" : "Manual Rota"} />
            <ReceiptRow
              label="Date"
              value={payment.paid_at ? new Date(payment.paid_at).toLocaleString("en-NG") : payment.date}
            />
            <ReceiptRow label="Reference" value={payment.transaction_ref || "—"} mono />
          </div>
        </div>

        {imgError && (
          <p className="text-xs mb-2 text-center" style={{ color: T.warn, fontFamily: FONT_BODY }}>
            {imgError}
          </p>
        )}
        <button
          onClick={shareImage}
          disabled={shareState === "generating"}
          className="w-full rounded-2xl py-3 font-semibold text-sm flex items-center justify-center gap-2 transition-transform active:scale-95 mb-2"
          style={{ background: T.gold, color: T.ink2, fontFamily: FONT_BODY }}
        >
          {shareState === "generating" ? <Loader2 size={15} className="animate-spin" /> : <Share2 size={15} />}
          {shareState === "generating" ? "Preparing image..." : "Share as image"}
        </button>
        <button onClick={copyText} className="w-full text-center text-xs py-1" style={{ color: T.muted, fontFamily: FONT_BODY }}>
          {shareState === "copied" ? "Copied to clipboard" : "Copy as text instead"}
        </button>
      </div>
    </div>
  );
}

// Same branded, shareable receipt card as ReceiptSheet, but for a wallet
// transaction (dva_wallet_transactions row) rather than a scheduled payment
// — different shape, same visual design.
function WalletReceiptSheet({ txn, onClose }) {
  const [shareState, setShareState] = useState("idle");
  const [imgError, setImgError] = useState("");
  const isCredit = txn.type === "credit";

  const rows = [
    ["Amount", naira(txn.amount)],
    [
      isCredit ? "From" : "To",
      txn.counterparty_name || (isCredit ? "Bank transfer" : "Recipient"),
    ],
    txn.counterparty_bank ? ["Bank", txn.counterparty_bank] : null,
    txn.description ? ["Description", txn.description] : null,
    ["Date", txn.created_at ? new Date(txn.created_at).toLocaleString("en-NG") : "—"],
    ["Reference", txn.id ? String(txn.id).slice(0, 12) : "—"],
  ].filter(Boolean);
  const listRows = rows.filter(([label]) => label !== "Amount");

  async function buildReceiptImage() {
    await document.fonts.ready.catch(() => {});
    const W = 720;
    const rowH = 54;
    const H = 400 + listRows.length * rowH;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#FBF8F2";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#8B5CF6";
    ctx.fillRect(0, 0, W, 12);

    let y = 74;
    const logo = await loadLogoImage();
    if (logo) {
      ctx.drawImage(logo, 48, y - 38, 40, 40);
      ctx.fillStyle = "#2E2A22";
      ctx.font = "600 30px Fredoka, sans-serif";
      ctx.fillText("rota", 48 + 40 + 14, y);
    } else {
      ctx.fillStyle = "#2E2A22";
      ctx.font = "600 32px Fredoka, sans-serif";
      ctx.fillText("rota", 48, y);
    }

    y += 34;
    ctx.fillStyle = "#9C927F";
    ctx.font = "600 15px Nunito, sans-serif";
    ctx.fillText(isCredit ? "MONEY RECEIVED" : "MONEY SENT", 48, y);

    y += 72;
    ctx.fillStyle = isCredit ? "#1FC28B" : "#2E2A22";
    ctx.font = "600 50px 'IBM Plex Mono', monospace";
    ctx.fillText(`${isCredit ? "+" : "-"}${naira(txn.amount)}`, 48, y);

    y += 38;
    ctx.strokeStyle = "#EDE4D3";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(48, y);
    ctx.lineTo(W - 48, y);
    ctx.stroke();

    y += 44;
    for (const [label, value] of listRows) {
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

    y += 6;
    ctx.strokeStyle = "#EDE4D3";
    ctx.beginPath();
    ctx.moveTo(48, y);
    ctx.lineTo(W - 48, y);
    ctx.stroke();

    y += 42;
    ctx.fillStyle = "#9C927F";
    ctx.font = "italic 14px Nunito, sans-serif";
    ctx.fillText("Money, on schedule. — Rota", 48, y);

    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png", 0.95));
  }

  async function shareImage() {
    setShareState("generating");
    setImgError("");
    try {
      const blob = await buildReceiptImage();
      if (!blob) throw new Error("Could not render image");
      const file = new File([blob], `rota-receipt-${txn.id || Date.now()}.png`, { type: "image/png" });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "Rota receipt" });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
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
    const text = [`Rota ${isCredit ? "receipt (received)" : "receipt (sent)"}`, ...rows.map(([l, v]) => `${l}: ${v}`)].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setShareState("copied");
      setTimeout(() => setShareState("idle"), 1500);
    } catch {
      // clipboard unavailable — no-op
    }
  }

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 25 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 max-w-lg mx-auto w-full" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            Receipt
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>

        <div className="rounded-2xl p-4 mb-4" style={{ background: T.ink, border: `1px solid ${T.ink3}` }}>
          <div className="flex items-center gap-2 mb-3">
            <div className="rounded-full flex items-center justify-center" style={{ width: 30, height: 30, background: T.ok }}>
              {isCredit ? <ArrowDownLeft size={16} color={T.ink} /> : <ArrowUpRight size={16} color={T.ink} />}
            </div>
            <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm font-medium">
              {isCredit ? "Money received" : "Money sent"}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {rows.map(([label, value]) => (
              <ReceiptRow key={label} label={label} value={value} mono={label === "Amount" || label === "Reference"} />
            ))}
          </div>
        </div>

        {imgError && (
          <p className="text-xs mb-2 text-center" style={{ color: T.warn, fontFamily: FONT_BODY }}>
            {imgError}
          </p>
        )}
        <button
          onClick={shareImage}
          disabled={shareState === "generating"}
          className="w-full rounded-2xl py-3 font-semibold text-sm flex items-center justify-center gap-2 transition-transform active:scale-95 mb-2"
          style={{ background: T.gold, color: T.ink2, fontFamily: FONT_BODY }}
        >
          {shareState === "generating" ? <Loader2 size={15} className="animate-spin" /> : <Share2 size={15} />}
          {shareState === "generating" ? "Preparing image..." : "Share as image"}
        </button>
        <button onClick={copyText} className="w-full text-center text-xs py-1" style={{ color: T.muted, fontFamily: FONT_BODY }}>
          {shareState === "copied" ? "Copied to clipboard" : "Copy as text instead"}
        </button>
      </div>
    </div>
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
function ProfileTab({ settings, onUpdate, onLogout, onReset, onUnlink, onUploadAvatar, onBiometricChange, hasBiometricConfirm, email, onCardLinked }) {
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(settings.name);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const [pwSheetOpen, setPwSheetOpen] = useState(false);
  const [pinSheetOpen, setPinSheetOpen] = useState(false);
  const [cardSheetOpen, setCardSheetOpen] = useState(false);
  const [linkOverlayOpen, setLinkOverlayOpen] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);
  const [bioError, setBioError] = useState("");
  const fileInputRef = useRef(null);

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
        <Row icon={Fingerprint} label="Biometric confirm">
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
        onClick={onReset}
        className="rounded-2xl p-3.5 flex items-center gap-3"
        style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}
      >
        <RotateCcw size={16} color={T.muted} />
        <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm">
          Clear all data
        </span>
      </button>

      <button onClick={onLogout} className="rounded-2xl p-3.5 flex items-center gap-3" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <LogOut size={16} color={T.warn} />
        <span style={{ fontFamily: FONT_BODY, color: T.warn }} className="text-sm">
          Log out
        </span>
      </button>

      {pwSheetOpen && <PasswordChangeSheet onClose={() => setPwSheetOpen(false)} />}
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

function Row({ icon: Icon, label, children }) {
  return (
    <div className="flex items-center justify-between px-4 py-3.5" style={{ borderBottom: `1px solid ${T.ink3}` }}>
      <div className="flex items-center gap-3">
        <Icon size={16} color={T.muted} />
        <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm">
          {label}
        </span>
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

/* ---------- Auth ---------- */
function AuthScreen() {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [checkEmail, setCheckEmail] = useState(false);

  async function submit() {
    if (!email.trim() || !password || submitting) return;
    setSubmitting(true);
    setError("");
    setCheckEmail(false);
    if (mode === "signup") {
      const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
      if (error) setError(error.message);
      else if (!data.session) setCheckEmail(true);
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) setError(error.message);
    }
    setSubmitting(false);
  }

  return (
    <div className="h-full flex flex-col justify-center px-7" style={{ background: T.ink, paddingTop: "max(40px, env(safe-area-inset-top))", paddingBottom: "max(40px, env(safe-area-inset-bottom))" }}>
      <span style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-2xl font-semibold mb-1">
        {mode === "signup" ? "Create your account" : "Welcome back"}
      </span>
      <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-sm mb-6">
        {mode === "signup" ? "A few seconds and you're in." : "Log in to see your schedule."}
      </p>

      {checkEmail ? (
        <p className="text-sm" style={{ color: T.ok, fontFamily: FONT_BODY }}>
          Check your email to confirm your account, then log in below.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
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
          <div>
            <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 6 characters"
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
  // Native enrollment is device-local (Keystore-bound), unlike WebAuthn's
  // account-level registration — tracked separately so switching devices
  // doesn't inherit a stale "enrolled" state from one that never enrolled.
  const [nativeBioEnrolled, setNativeBioEnrolled] = useState(() => IS_NATIVE && localStorage.getItem(NATIVE_BIO_FLAG_KEY) === "1");
  const hasBiometricConfirm = IS_NATIVE ? nativeBioEnrolled : settings.biometricRegistered;
  const [tapClaimToken, setTapClaimToken] = useState(() => new URLSearchParams(window.location.search).get("tap"));
  const homeScrollRef = useRef(null);

  // App Links land here instead of a fresh page load, so pick the token
  // out of the launch URL by hand and feed it into the same state the
  // ?tap= query-param path already uses — no separate claim UI needed.
  useEffect(() => {
    if (!IS_NATIVE) return;
    const sub = CapacitorApp.addListener("appUrlOpen", ({ url }) => {
      try {
        const token = new URL(url).searchParams.get("tap");
        if (token) setTapClaimToken(token);
      } catch {
        // not a URL we care about
      }
    });
    return () => {
      sub.then((handle) => handle.remove());
    };
  }, []);

  // Listens for a real NFC tap the whole time the app is open (paused only
  // while this same device is mid-emulation as the sender — see
  // TapSendSheet). Fully in-app: no OS tag-dispatch, no picker, no browser.
  useEffect(() => {
    if (!IS_NATIVE) return;
    RotaNfcReader.startListening().catch(() => {});
    const sub = RotaNfcReader.addListener("tapReceived", ({ url }) => {
      try {
        const token = new URL(url).searchParams.get("tap");
        if (token) setTapClaimToken(token);
      } catch {
        // not a URL we care about
      }
    });
    return () => {
      RotaNfcReader.stopListening().catch(() => {});
      sub.then((handle) => handle.remove());
    };
  }, []);

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

    return () => {
      regListener?.remove();
      errListener?.remove();
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
        .select("id,name,notifications,biometric,card_linked,card_last4,avatar_url,has_pin,total_balance,dark_mode,card_link_skipped")
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

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      if (data.session) loadUserData(data.session.user);
      else {
        setScreen("welcome");
        setAuthLoading(false);
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session) {
        loadUserData(session.user);
      } else if (event === "SIGNED_OUT") {
        setUser(null);
        setSettings(defaultSettings());
        setPayments([]);
        setTodos([]);
        setScreen("welcome");
      }
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
  const markPaymentPaid = useCallback((id) => {
    const ref = `MANUAL-${Date.now().toString(36).toUpperCase()}`;
    const paidAt = new Date().toISOString();
    setPayments((prev) => prev.map((p) => (p.id === id ? { ...p, status: "paid", paid_at: paidAt, transaction_ref: ref } : p)));
    supabase
      .from("payments")
      .update({ status: "paid", paid_at: paidAt, transaction_ref: ref })
      .eq("id", id)
      .then(({ error }) => {
        if (error) console.error("Mark paid failed", error);
      });
  }, []);
  const unmarkPaymentPaid = useCallback((id) => {
    setPayments((prev) => prev.map((p) => (p.id === id ? { ...p, status: "upcoming", paid_at: null, transaction_ref: null } : p)));
    supabase
      .from("payments")
      .update({ status: "upcoming", paid_at: null, transaction_ref: null })
      .eq("id", id)
      .then(({ error }) => {
        if (error) console.error("Unmark paid failed", error);
      });
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
          <AppHeader
            title={{ home: "Rota", schedule: "Schedule", todo: "To-Do", advisor: "Advisor", profile: "Profile" }[tab]}
            onProfile={tab !== "profile" ? () => setTab("profile") : undefined}
            avatarUrl={settings.avatarUrl}
            name={settings.name}
          />
          <div className="flex-1 overflow-y-auto rota-scroll-pad" ref={homeScrollRef}>
            <div className="max-w-2xl mx-auto w-full">
              {tab === "home" && (
                <PullToRefresh scrollRef={homeScrollRef} onRefresh={() => loadUserData(user)}>
                  <HomeTab payments={payments} settings={settings} goTab={setTab} onUpdate={updateSettings} user={user} hasBiometricConfirm={hasBiometricConfirm} />
                </PullToRefresh>
              )}
              {tab === "schedule" && (
                <ScheduleTab
                  payments={payments}
                  onAdd={addPayment}
                  onMarkPaid={markPaymentPaid}
                  onUnmarkPaid={unmarkPaymentPaid}
                  onEdit={editPayment}
                  onDelete={deletePayment}
                  onRetry={retryPayment}
                  senderName={settings.name}
                  hasPin={settings.hasPin}
                  hasBiometric={hasBiometricConfirm}
                  totalBalance={settings.totalBalance}
                />
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
                />
              )}
            </div>
          </div>
          <TabBar tab={tab} setTab={setTab} />
        </div>
      </div>
    </div>
  );
}
