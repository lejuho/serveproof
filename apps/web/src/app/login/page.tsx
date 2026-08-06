"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, setTokens } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("manager@demo.serveproof.local");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      // route by role from the JWT payload (WORKER → 내 소득, staff → dashboard)
      const payload = JSON.parse(atob(res.accessToken.split(".")[1] ?? "")) as { role?: string };
      router.push(payload.role === "WORKER" ? "/me" : "/dashboard");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-8">
      <h1 className="text-2xl font-bold">ServeProof 로그인</h1>
      {step === "email" ? (
        <>
          <label className="text-sm text-zinc-600">이메일</label>
          <input
            className="rounded-md border border-zinc-300 px-3 py-2"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
          />
          <button
            onClick={requestOtp}
            disabled={busy}
            className="rounded-md bg-zinc-900 px-4 py-2 text-white disabled:opacity-50"
          >
            인증 코드 받기
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-zinc-600">{email}로 전송된 6자리 코드를 입력하세요.</p>
          {devCode && (
            <p className="rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-800">
              로컬 개발 코드: <b>{devCode}</b>
            </p>
          )}
          <input
            className="rounded-md border border-zinc-300 px-3 py-2 tracking-widest"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={6}
            placeholder="000000"
          />
          <button
            onClick={verifyOtp}
            disabled={busy || code.length !== 6}
            className="rounded-md bg-zinc-900 px-4 py-2 text-white disabled:opacity-50"
          >
            로그인
          </button>
          <button onClick={() => setStep("email")} className="text-sm text-zinc-500 underline">
            이메일 다시 입력
          </button>
        </>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </main>
  );
}
