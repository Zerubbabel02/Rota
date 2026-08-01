import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabaseClient.js";
import { startRegistration, startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
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
} from "lucide-react";

/* ---------- Design tokens ---------- */
const T = {
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
};

const FONT_DISPLAY = "'Fredoka', 'Baloo 2', system-ui, sans-serif";
const FONT_BODY = "'Nunito', system-ui, -apple-system, sans-serif";
const FONT_MONO = "'IBM Plex Mono', ui-monospace, Menlo, monospace";

const CATEGORIES = ["Housing", "Utilities", "Entertainment", "Savings", "Transport", "Other"];
const PAYSTACK_PUBLIC_KEY = "pk_test_b8acc1eeb9f5b9140c1f20c56c426c16d3598add";
const CATEGORY_COLOR = {
  Housing: T.gold,
  Utilities: T.ok,
  Entertainment: T.warn,
  Savings: T.goldSoft,
  Transport: T.blue,
  Other: T.muted,
};

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
  return out;
}

/* ---------- Shared bits ---------- */
function AppHeader({ title, onProfile, avatarUrl, name }) {
  return (
    <div className="flex items-center justify-between px-5 pt-6 pb-3">
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
      className="flex items-center justify-between px-3"
      style={{ background: T.ink2, borderTop: `1px solid ${T.ink3}`, paddingTop: 10, paddingBottom: 14 }}
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

function CategoryChip({ category }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" style={{ fontFamily: FONT_BODY, color: T.muted }}>
      <span className="rounded-full" style={{ width: 6, height: 6, background: CATEGORY_COLOR[category] || T.muted }} />
      {category}
    </span>
  );
}

/* ---------- Welcome ---------- */
function WelcomeScreen({ onNext }) {
  return (
    <div className="h-full flex flex-col justify-between px-7 py-10" style={{ background: T.ink }}>
      <div>
        <div className="flex items-center gap-2">
          <div
            className="rounded-full flex items-center justify-center"
            style={{ width: 34, height: 34, background: T.gold }}
          >
            <Wallet size={17} color={T.ink} />
          </div>
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
    <div className="h-full flex flex-col px-6 py-8" style={{ background: T.ink }}>
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
function HomeTab({ payments, todos, settings, goTab, onUpdate }) {
  const [balanceSheetOpen, setBalanceSheetOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const totalBudgeted = payments.reduce((s, p) => s + p.amount, 0);
  const totalPaid = payments.filter((p) => p.status === "paid").reduce((s, p) => s + p.amount, 0);
  const pct = totalBudgeted ? Math.min(100, Math.round((totalPaid / totalBudgeted) * 100)) : 0;
  const upcoming = payments.filter((p) => p.status === "upcoming").sort((a, b) => a.date.localeCompare(b.date));
  const next = upcoming[0];
  const pendingTodos = todos.filter((t) => !t.done).length;
  const failedCount = payments.filter((p) => p.status === "failed").length;
  const recentPaid = payments
    .filter((p) => p.status === "paid")
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 3);

  const remaining = settings.totalBalance - totalBudgeted;
  const overBudget = remaining < 0;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

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

      <div className="rounded-2xl p-4" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <div className="flex justify-between items-center mb-1">
          <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
            Total balance
          </span>
          <button onClick={() => setBalanceSheetOpen(true)}>
            <Pencil size={12} color={T.muted} />
          </button>
        </div>
        <span style={{ fontFamily: FONT_MONO, color: T.paper }} className="text-2xl font-semibold">
          {naira(settings.totalBalance)}
        </span>
        <div className="mt-3 pt-3 flex items-center justify-between" style={{ borderTop: `1px solid ${T.ink3}` }}>
          <span style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
            Scheduled budget
          </span>
          <span style={{ fontFamily: FONT_MONO, color: T.paper }} className="text-xs">
            {naira(totalBudgeted)}
          </span>
        </div>
        <span
          className="text-xs"
          style={{ fontFamily: FONT_BODY, color: overBudget ? T.warn : T.ok }}
        >
          {overBudget
            ? `Over by ${naira(Math.abs(remaining))} \u2014 some Rotas may fail if funds aren't available`
            : `${naira(remaining)} left uncommitted`}
        </span>
      </div>

      <div className="rounded-2xl p-4" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
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

      {next && (
        <button
          onClick={() => goTab("schedule")}
          className="rounded-2xl p-4 text-left"
          style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="rounded-xl flex items-center justify-center" style={{ width: 38, height: 38, background: T.ink3 }}>
                <Clock size={17} color={T.gold} />
              </div>
              <div>
                <p style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-sm font-medium">
                  {next.name}
                </p>
                <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
                  {daysAway(next.date)} · {naira(next.amount)}
                </p>
              </div>
            </div>
          </div>
        </button>
      )}

      <div className="flex gap-3">
        <button
          onClick={() => goTab("schedule")}
          className="flex-1 rounded-2xl py-3 flex flex-col items-center gap-1.5 transition-transform active:scale-95"
          style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}
        >
          <Plus size={16} color={T.gold} />
          <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-xs">
            Add payment
          </span>
        </button>
        <button
          onClick={() => goTab("todo")}
          className="flex-1 rounded-2xl py-3 flex flex-col items-center gap-1.5 transition-transform active:scale-95"
          style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}
        >
          <CheckSquare size={16} color={T.gold} />
          <span style={{ fontFamily: FONT_BODY, color: T.paper }} className="text-xs">
            {pendingTodos} to-dos
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

      <div>
        <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs mb-2">
          Recent activity
        </p>
        <div className="flex flex-col gap-2">
          {recentPaid.map((p) => (
            <div key={p.id} className="rounded-xl p-3 flex items-center justify-between" style={{ background: T.ink2 }}>
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

      {balanceSheetOpen && (
        <BalanceSheet
          current={settings.totalBalance}
          onClose={() => setBalanceSheetOpen(false)}
          onSave={(v) => {
            onUpdate({ totalBalance: v });
            setBalanceSheetOpen(false);
          }}
        />
      )}
      {historyOpen && (
        <TransactionHistorySheet payments={payments} senderName={settings.name} onClose={() => setHistoryOpen(false)} />
      )}
    </div>
  );
}

function TransactionHistorySheet({ payments, senderName, onClose }) {
  const [receiptFor, setReceiptFor] = useState(null);
  const paid = [...payments].filter((p) => p.status === "paid").sort((a, b) => (b.paid_at || b.date).localeCompare(a.paid_at || a.date));

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 21 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5 overflow-y-auto" style={{ background: T.ink2, border: `1px solid ${T.ink3}`, maxHeight: "80vh" }}>
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

function BalanceSheet({ current, onClose, onSave }) {
  const [value, setValue] = useState(String(current || ""));
  const canSave = Number(value) >= 0 && value !== "";

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 22 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            Set total balance
          </h3>
          <button onClick={onClose}>
            <X size={18} color={T.muted} />
          </button>
        </div>
        <p className="text-xs mb-3" style={{ color: T.muted, fontFamily: FONT_BODY }}>
          This is what you tell Rota you have available — it's used to compare against your scheduled Rotas, not
          a real account balance Rota holds.
        </p>
        <div>
          <label style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs block mb-1.5">
            Amount (₦)
          </label>
          <input
            type="number"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && canSave && onSave(Number(value))}
            className="w-full rounded-xl px-3 py-2.5 text-sm"
            style={{ background: T.ink, border: `1px solid ${T.ink3}`, color: T.paper, fontFamily: FONT_MONO }}
          />
        </div>
        <button
          disabled={!canSave}
          onClick={() => onSave(Number(value))}
          className="w-full rounded-2xl py-3 font-semibold text-sm mt-3 transition-transform active:scale-95"
          style={{ background: canSave ? T.gold : T.ink3, color: canSave ? T.ink2 : T.muted, fontFamily: FONT_BODY }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

/* ---------- Schedule tab ---------- */
function ScheduleTab({ payments, onAdd, onEdit, onMarkPaid, onUnmarkPaid, onDelete, onRetry, senderName, hasPin, hasBiometric, totalBalance }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [receiptFor, setReceiptFor] = useState(null);
  const [detailFor, setDetailFor] = useState(null);
  const sorted = [...payments].sort((a, b) => a.date.localeCompare(b.date));
  const today = todayISO();

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
                        className="text-[10px] px-1.5 py-0.5 rounded-full"
                        style={{
                          fontFamily: FONT_BODY,
                          color: isAutomatic ? T.blue : T.muted,
                          background: isAutomatic ? `${T.blue}1A` : T.ink3,
                        }}
                      >
                        {isAutomatic ? "Automatic Rota" : "Manual Rota"}
                      </span>
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
                  <button onClick={(e) => { e.stopPropagation(); onDelete(p.id); }}>
                    <Trash2 size={14} color={T.muted} />
                  </button>
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
          onClose={() => setDetailFor(null)}
          onSave={(updates) => {
            onEdit(detailFor.id, updates);
            setDetailFor(null);
          }}
        />
      )}
    </div>
  );
}

let cachedBanks = null;

function ScheduleDetailSheet({ payment, onClose, onSave }) {
  const canEdit = payment.status === "upcoming";
  const [editing, setEditing] = useState(false);
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
      <div className="relative rounded-t-3xl p-5 overflow-y-auto" style={{ background: T.ink2, border: `1px solid ${T.ink3}`, maxHeight: "70vh" }}>
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
      <div className="relative rounded-t-3xl p-5 overflow-y-auto" style={{ background: T.ink2, border: `1px solid ${T.ink3}`, maxHeight: "85vh" }}>
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            Add payment
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
      <div className="relative rounded-t-3xl p-5 flex flex-col" style={{ background: T.ink2, border: `1px solid ${T.ink3}`, maxHeight: "75vh" }}>
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
    ctx.fillStyle = "#2E2A22";
    ctx.font = "600 32px Fredoka, sans-serif";
    ctx.fillText("Rota", 48, y);

    ctx.fillStyle = "#1FC28B";
    ctx.beginPath();
    ctx.arc(W - 48 - 14, y - 10, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#FBF8F2";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(W - 48 - 20, y - 10);
    ctx.lineTo(W - 48 - 15, y - 4);
    ctx.lineTo(W - 48 - 7, y - 17);
    ctx.stroke();

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
      <div className="relative rounded-t-3xl p-5" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
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
      <div className="relative rounded-t-3xl p-5" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
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
function ProfileTab({ settings, onUpdate, onLogout, onReset, onUnlink, onUploadAvatar, onBiometricChange }) {
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(settings.name);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const [pwSheetOpen, setPwSheetOpen] = useState(false);
  const [pinSheetOpen, setPinSheetOpen] = useState(false);
  const [cardSheetOpen, setCardSheetOpen] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);
  const [bioError, setBioError] = useState("");
  const fileInputRef = useRef(null);

  async function enableBiometric() {
    setBioBusy(true);
    setBioError("");
    try {
      if (!browserSupportsWebAuthn()) throw new Error("This browser doesn't support biometric sign-in.");
      const { data: options, error: optErr } = await supabase.functions.invoke("webauthn-register-options", { body: {} });
      if (optErr || options?.error) throw new Error((options && options.error) || "Couldn't start registration.");
      const attResp = await startRegistration({ optionsJSON: options });
      const { data, error: verErr } = await supabase.functions.invoke("webauthn-register-verify", { body: { response: attResp } });
      if (verErr || !data?.success) throw new Error((data && data.error) || "Couldn't verify that device.");
      onBiometricChange(true);
    } catch (e) {
      if (e?.name !== "NotAllowedError") setBioError(e.message || "Couldn't enable biometrics.");
    } finally {
      setBioBusy(false);
    }
  }

  async function disableBiometric() {
    setBioBusy(true);
    setBioError("");
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
          <button onClick={() => settings.cardLinked && setCardSheetOpen(true)} className="flex items-center gap-1.5">
            <p style={{ fontFamily: FONT_BODY, color: T.muted }} className="text-xs">
              {settings.cardLinked ? `Debit card •••• ${settings.cardLast4}` : "No card linked"}
            </p>
            {settings.cardLinked && <ChevronDown size={11} color={T.muted} style={{ transform: "rotate(-90deg)" }} />}
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
          ) : settings.biometricRegistered ? (
            <button onClick={disableBiometric} className="text-xs font-medium" style={{ color: T.warn, fontFamily: FONT_BODY }}>
              Remove
            </button>
          ) : (
            <button onClick={enableBiometric} className="text-xs font-medium" style={{ color: T.gold, fontFamily: FONT_BODY }}>
              Enable
            </button>
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
          hasBiometric={settings.biometricRegistered}
          onClose={() => setCardSheetOpen(false)}
          onChangeCard={() => {
            setCardSheetOpen(false);
            onUnlink();
          }}
        />
      )}
    </div>
  );
}

function CardDetailSheet({ last4, hasPin, hasBiometric, onClose, onChangeCard }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 22 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
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
      <div className="relative rounded-t-3xl p-5" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
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

function ConfirmSheet({ hasBiometric, onClose, onConfirmed }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function tryBiometric() {
    setError("");
    setSubmitting(true);
    try {
      if (!browserSupportsWebAuthn()) throw new Error("This browser doesn't support biometrics — use your PIN.");
      const { data: options, error: optErr } = await supabase.functions.invoke("webauthn-auth-options", { body: {} });
      if (optErr || options?.error) throw new Error((options && options.error) || "Biometrics unavailable.");
      const assertion = await startAuthentication({ optionsJSON: options });
      const { data, error: verErr } = await supabase.functions.invoke("webauthn-auth-verify", { body: { response: assertion } });
      if (verErr || !data?.success) throw new Error((data && data.error) || "Couldn't verify.");
      onConfirmed();
    } catch (e) {
      if (e?.name !== "NotAllowedError") setError(e.message || "Couldn't verify — use your PIN instead.");
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
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 24 }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose} />
      <div className="relative rounded-t-3xl p-5" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontFamily: FONT_DISPLAY, color: T.paper }} className="text-lg font-semibold">
            Confirm to schedule
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
          Confirm with PIN
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
      <div className="relative rounded-t-3xl p-5" style={{ background: T.ink2, border: `1px solid ${T.ink3}` }}>
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
  const [mode, setMode] = useState("signup");
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
    <div className="h-full flex flex-col justify-center px-7 py-10" style={{ background: T.ink }}>
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
        className="w-full text-center text-xs mt-5"
        style={{ color: T.muted, fontFamily: FONT_BODY }}
      >
        {mode === "signup" ? "Already have an account? Log in" : "New here? Sign up"}
      </button>
    </div>
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

  const loadUserData = useCallback(async (authUser) => {
    const [{ data: profileRow }, { data: paymentRows }, { data: todoRows }] = await Promise.all([
      supabase
        .from("profiles")
        .select("id,name,notifications,biometric,card_linked,card_last4,avatar_url,has_pin,total_balance")
        .eq("id", authUser.id)
        .single(),
      supabase.from("payments").select("*").eq("user_id", authUser.id).order("date", { ascending: true }),
      supabase.from("todos").select("*").eq("user_id", authUser.id).order("created_at", { ascending: true }),
    ]);
    setUser(authUser);
    setSettings(profileRow ? mapProfile(profileRow) : defaultSettings());
    setPayments((paymentRows || []).map((p) => ({ ...p, amount: Number(p.amount) })));
    setTodos(todoRows || []);
    setScreen(profileRow && profileRow.card_linked ? "app" : "link");
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
  function handleSkipLink() {
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

  const bodyStyle = { background: T.ink, height: "100%", display: "flex", flexDirection: "column" };

  return (
    <div className="w-full flex justify-center" style={{ background: T.ink3, minHeight: "100vh" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Nunito:wght@400;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        .rota-shell { height: 100vh; height: 100dvh; }
      `}</style>
      <div
        className="rota-shell w-full sm:max-w-md relative overflow-hidden"
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
        ) : screen === "link" ? (
          <LinkScreen email={user?.email} onLinked={handleLinked} onSkip={handleSkipLink} />
        ) : (
          <div style={bodyStyle}>
            <AppHeader
              title={{ home: "Rota", schedule: "Schedule", todo: "To-Do", advisor: "Advisor", profile: "Profile" }[tab]}
              onProfile={tab !== "profile" ? () => setTab("profile") : undefined}
              avatarUrl={settings.avatarUrl}
              name={settings.name}
            />
            <div className="flex-1 overflow-y-auto">
              {tab === "home" && <HomeTab payments={payments} todos={todos} settings={settings} goTab={setTab} onUpdate={updateSettings} />}
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
                  hasBiometric={settings.biometricRegistered}
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
                  onBiometricChange={(v) => setSettings((prev) => ({ ...prev, biometricRegistered: v }))}
                />
              )}
            </div>
            <TabBar tab={tab} setTab={setTab} />
          </div>
        )}
      </div>
    </div>
  );
}
