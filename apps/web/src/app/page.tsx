export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-3xl font-bold tracking-tight">ServeProof</h1>
      <p className="text-center text-zinc-600">
        Income and tax observability layer for tipped workers — connecting tips, shifts, approved
        allocations, payouts, and payroll into one verifiable lifecycle.
      </p>
      <a
        href="/login"
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-700"
      >
        로그인
      </a>
    </main>
  );
}
