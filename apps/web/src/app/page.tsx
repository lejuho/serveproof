"use client";

import { LanguageToggle, Logo } from "@/components/ui";
import { useI18n } from "@/lib/i18n";

export default function Home() {
  const { locale, t } = useI18n();

  return (
    <main className="flex min-h-screen flex-col bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
          <Logo />
          <div className="flex items-center gap-4">
            <LanguageToggle />
            <a
              href="/login"
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-zinc-700"
            >
              {t("landing.login")}
            </a>
          </div>
        </div>
      </header>

      <section className="mx-auto flex max-w-3xl flex-1 flex-col items-center justify-center gap-6 px-6 py-20 text-center">
        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-4 py-1.5 text-sm font-medium text-emerald-700">
          {t("landing.badge")}
        </span>
        <h1 className="text-5xl font-black leading-tight tracking-tight text-zinc-900">
          {locale === "ko" ? (
            <>
              팁 소득을
              <br />
              <span className="text-emerald-600">검증 가능한 증명</span>으로
            </>
          ) : (
            <>
              Turn tip income into
              <br />
              <span className="text-emerald-600">verifiable proof</span>
            </>
          )}
        </h1>
        <p className="max-w-xl text-lg leading-relaxed text-zinc-500">{t("landing.desc")}</p>
        <div className="mt-2 flex gap-3">
          <a
            href="/login"
            className="rounded-lg bg-emerald-600 px-6 py-3 text-base font-semibold text-white shadow-sm shadow-emerald-600/25 transition-colors hover:bg-emerald-700"
          >
            {t("landing.cta")}
          </a>
        </div>
        <div className="mt-10 grid grid-cols-1 gap-3 text-left sm:grid-cols-3">
          {[1, 2, 3].map((n) => (
            <div key={n} className="rounded-2xl border border-zinc-200 bg-white p-5">
              <p className="font-semibold text-zinc-900">{t(`landing.f${n}.title`)}</p>
              <p className="mt-1 text-sm leading-relaxed text-zinc-500">
                {t(`landing.f${n}.body`)}
              </p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-zinc-200 py-6 text-center text-xs text-zinc-400">
        {t("landing.footer")}
      </footer>
    </main>
  );
}
