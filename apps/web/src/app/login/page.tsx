"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  activateSession,
  api,
  getStoredSessions,
  restoreSession,
  setTokens,
  type StoredSession,
} from "@/lib/api";
import { Button, Callout, LanguageToggle, Logo, inputClass } from "@/components/ui";
import { useI18n } from "@/lib/i18n";

export default function LoginPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [email, setEmail] = useState("manager@demo.serveproof.local");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [switchMode, setSwitchMode] = useState(false);
  const [savedSessions, setSavedSessions] = useState<StoredSession[]>([]);

  useEffect(() => {
    let active = true;
    const switching = new URLSearchParams(window.location.search).get("switch") === "1";
    setSwitchMode(switching);
    setSavedSessions(getStoredSessions());
    if (switching) {
      setCheckingSession(false);
      return () => {
        active = false;
      };
    }
    restoreSession().then((destination) => {
      if (!active) return;
      if (destination) router.replace(destination);
      else setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router]);

  async function requestOtp() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ sent: boolean; devCode?: string }>("/auth/otp/request", {
        method: "POST",
        body: { email },
        auth: false,
      });
      setDevCode(res.devCode ?? null);
      setStep("code");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send code");
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ accessToken: string; refreshToken: string }>("/auth/otp/verify", {
        method: "POST",
        body: { email, code },
        auth: false,
      });
      setTokens(res.accessToken, res.refreshToken);
      router.push((await restoreSession()) ?? "/login");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  }

  if (checkingSession) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">
        {t("auth.restoring")}
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center justify-between">
          <Logo size={36} />
          <LanguageToggle />
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 shadow-[0_4px_16px_rgba(0,0,0,0.05)]">
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900">{t("login.title")}</h1>
          <p className="mt-1 text-sm text-zinc-500">{t("login.subtitle")}</p>

          <div className="mt-6 flex flex-col gap-4">
            {switchMode && savedSessions.length > 0 && step === "email" && (
              <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
                <p className="px-1 text-xs font-semibold text-zinc-500">
                  {t("login.savedAccounts")}
                </p>
                <div className="mt-2 flex flex-col gap-2">
                  {savedSessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => {
                        const destination = activateSession(session.id);
                        if (destination) router.push(destination);
                      }}
                      className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-left hover:border-emerald-300 hover:bg-emerald-50"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-zinc-800">
                          {session.email || t("login.savedAccount")}
                        </span>
                        <span className="block text-xs text-zinc-400">
                          {session.modes
                            .map((mode) =>
                              mode === "worker"
                                ? t("login.workerAccount")
                                : t("login.staffAccount"),
                            )
                            .join(" · ")}
                        </span>
                      </span>
                      <span className="text-xs font-semibold text-emerald-700">
                        {t("login.continue")}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {step === "email" ? (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-zinc-700">{t("login.email")}</span>
                  <input
                    className={inputClass}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    type="email"
                    onKeyDown={(e) => e.key === "Enter" && requestOtp()}
                  />
                </label>
                <Button onClick={requestOtp} disabled={busy} className="w-full">
                  {t("login.request")}
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm text-zinc-500">
                  <b className="text-zinc-800">{email}</b>
                  {t("login.sentTo")}
                </p>
                {devCode && (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
                    {t("login.devCode")}: <b className="font-mono text-base">{devCode}</b>
                  </p>
                )}
                <input
                  className={`${inputClass} text-center font-mono text-xl tracking-[0.4em]`}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  maxLength={6}
                  placeholder="000000"
                  onKeyDown={(e) => e.key === "Enter" && code.length === 6 && verifyOtp()}
                />
                <Button onClick={verifyOtp} disabled={busy || code.length !== 6} className="w-full">
                  {t("login.submit")}
                </Button>
                <button
                  onClick={() => setStep("email")}
                  className="text-sm text-zinc-400 underline-offset-2 hover:text-zinc-600 hover:underline"
                >
                  {t("login.back")}
                </button>
              </>
            )}
            {error && <Callout tone="red">{error}</Callout>}
          </div>
        </div>
        <p className="mt-6 text-center text-xs text-zinc-400">
          {t("login.demo")}: manager@demo.serveproof.local · worker.b@demo.serveproof.local
        </p>
      </div>
    </main>
  );
}
