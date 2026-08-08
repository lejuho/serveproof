"use client";

import type { ReactNode } from "react";
import { useI18n, type Locale } from "@/lib/i18n";

/** ServeProof design system — clean fintech look (Stripe/Column 계열). */

export function LanguageToggle() {
  const { locale, setLocale } = useI18n();
  const segment = (value: Locale, label: string) => (
    <button
      onClick={() => setLocale(value)}
      aria-pressed={locale === value}
      className={`rounded-md px-2 py-1 text-xs font-bold transition-colors ${
        locale === value ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-400 hover:text-zinc-600"
      }`}
    >
      {label}
    </button>
  );
  return (
    <span className="inline-flex items-center gap-0.5 rounded-lg bg-zinc-100 p-0.5">
      {segment("ko", "KO")}
      {segment("en", "EN")}
    </span>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
        <rect x="2" y="2" width="28" height="28" rx="8" className="fill-emerald-600" />
        <path
          d="M9.5 16.5l4.2 4.2 8.8-9.4"
          stroke="white"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="text-lg font-bold tracking-tight text-zinc-900">
        Serve<span className="text-emerald-600">Proof</span>
      </span>
    </span>
  );
}

export function AppShell({
  title,
  subtitle,
  right,
  wide,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  right?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/85 backdrop-blur">
        <div
          className={`mx-auto flex h-16 items-center justify-between px-6 ${wide ? "max-w-6xl" : "max-w-3xl"}`}
        >
          <Logo />
          <div className="flex items-center gap-4">
            <LanguageToggle />
            {right}
          </div>
        </div>
      </header>
      <main
        className={`mx-auto flex flex-col gap-6 px-6 py-10 ${wide ? "max-w-6xl" : "max-w-3xl"}`}
      >
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900">{title}</h1>
          {subtitle && <p className="mt-1.5 text-[15px] text-zinc-500">{subtitle}</p>}
        </div>
        {children}
      </main>
    </div>
  );
}

export function Card({
  step,
  title,
  description,
  children,
  className = "",
}: {
  step?: number;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-zinc-200 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)] ${className}`}
    >
      {title && (
        <div className="mb-4 flex items-start gap-3">
          {step !== undefined && (
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-600/10 text-sm font-bold text-emerald-700">
              {step}
            </span>
          )}
          <div>
            <h2 className="text-lg font-semibold text-zinc-900">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-zinc-500">{description}</p>}
          </div>
        </div>
      )}
      {children}
    </section>
  );
}

const BUTTON_VARIANTS: Record<string, string> = {
  primary:
    "bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm shadow-emerald-600/20 disabled:hover:bg-emerald-600",
  dark: "bg-zinc-900 text-white hover:bg-zinc-700 disabled:hover:bg-zinc-900",
  secondary:
    "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 disabled:hover:bg-white",
  danger: "bg-red-600 text-white hover:bg-red-700 disabled:hover:bg-red-600",
  violet: "bg-violet-600 text-white hover:bg-violet-700 disabled:hover:bg-violet-600",
};

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: "sm" | "md";
}) {
  const sizeClass = size === "sm" ? "px-3 py-1.5 text-[13px]" : "px-4 py-2.5 text-sm";
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${sizeClass} ${BUTTON_VARIANTS[variant]} ${className}`}
    />
  );
}

const BADGE_TONES: Record<string, string> = {
  // batch / payout states
  CALCULATED: "bg-blue-50 text-blue-700 ring-blue-600/20",
  REVIEW_REQUIRED: "bg-amber-50 text-amber-700 ring-amber-600/25",
  PAYABLE: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  PARTIALLY_PAID: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  PAID: "bg-emerald-600 text-white ring-emerald-600",
  DRAFT: "bg-zinc-100 text-zinc-600 ring-zinc-400/30",
  UNPAID: "bg-zinc-100 text-zinc-600 ring-zinc-400/30",
  PENDING: "bg-blue-50 text-blue-700 ring-blue-600/20",
  FAILED: "bg-red-50 text-red-700 ring-red-600/20",
  ISSUED: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  // withholding
  CONFIRMED: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  UNKNOWN: "bg-zinc-100 text-zinc-500 ring-zinc-400/30",
  // grades
  A: "bg-emerald-50 text-emerald-700 ring-emerald-600/25",
  B: "bg-blue-50 text-blue-700 ring-blue-600/25",
  C: "bg-amber-50 text-amber-700 ring-amber-600/25",
  D: "bg-orange-50 text-orange-700 ring-orange-600/25",
  E: "bg-red-50 text-red-700 ring-red-600/25",
};

export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  const toneClass = (tone && BADGE_TONES[tone]) ?? "bg-zinc-100 text-zinc-600 ring-zinc-400/30";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${toneClass}`}
    >
      {children}
    </span>
  );
}

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <p className="text-[13px] font-medium text-zinc-500">{label}</p>
      <p className="mt-1.5 text-[26px] font-bold tracking-tight text-zinc-900 tabular-nums">
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-zinc-400">{hint}</p>}
    </div>
  );
}

export const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-white px-3.5 py-2.5 text-[15px] text-zinc-900 placeholder-zinc-400 shadow-sm outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20";

export function Callout({
  children,
  tone = "amber",
}: {
  children: ReactNode;
  tone?: "amber" | "red" | "emerald";
}) {
  const tones = {
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    red: "border-red-200 bg-red-50 text-red-700",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
  };
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm leading-relaxed ${tones[tone]}`}>
      {children}
    </div>
  );
}

export const tableHeadClass =
  "border-b border-zinc-200 pb-2.5 pr-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-400";
export const tableCellClass = "border-b border-zinc-100 py-3 pr-3 text-[15px] text-zinc-700";
