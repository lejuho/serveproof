# ServeProof demo preparation

This runbook creates a repeatable presentation baseline for `ServeProof Demo / Demo Diner`.

## What is preserved

- Demo organization, venue, users, and memberships
- Worker wallets and the venue signer
- On-chain venue/vault configuration
- Allocation policies and provider connections

## What is reset

- Tip and shift evidence
- Allocation batches, allocations, and payouts
- Payroll records, income entries, and discrepancy alerts
- Demo-worker disclosure grants, reports, and access logs
- Demo-venue staffing rows and audit logs

Solana transactions cannot be deleted. Before removing the local payout rows, the script archives every known USDC signature and its Solscan URL under `demo-artifacts/previous-onchain-*.json`.

## Prepare the local demo

Start the local data services and ensure the base seed exists:

```bash
docker compose up -d postgres redis
pnpm --filter @serveproof/db migrate:deploy
pnpm --filter @serveproof/db seed
```

The seed uses one canonical identity for `Demo Diner` and refuses to create or
reuse a venue with a different UUID. Smoke and presentation state are kept in
separate files under `onchain/state/`.

Run the read-only readiness check before every reset or rehearsal:

```bash
pnpm demo:doctor
```

It verifies the manager membership, worker mappings and wallets, canonical PDA,
on-chain venue authority, vault mint/owner/balance, and signer SOL. The prepare
command runs the same check and stops before deleting data if anything fails.

Preview the target and row counts without changing data:

```bash
pnpm demo:prepare
```

Apply the scoped reset and create the presentation baseline:

```bash
DEMO_PREPARE_APPLY=1 DEMO_PREPARE_CONFIRM='Demo Diner' pnpm demo:prepare
```

The command refuses to run in `APP_ENV=production` and only applies when the confirmation text exactly matches the venue name.

For the remote demo, supply the staging database URL without putting it in shell history:

```bash
read -rsp "Railway DATABASE_URL: " DEMO_DATABASE_URL; printf '\n'
APP_ENV=staging DATABASE_URL="$DEMO_DATABASE_URL" pnpm demo:doctor
APP_ENV=staging DATABASE_URL="$DEMO_DATABASE_URL" pnpm demo:prepare
```

The one-time Demo Diner Devnet bootstrap is venue-scoped and simulates every
transaction before broadcasting:

```bash
cd onchain
NO_DNA=1 node scripts/init-devnet.mjs demo
```

## Result

- Four completed historical PAYROLL batches through two days ago
- Alice, Bob, and Carol income-ledger history
- At least one grade-A Alice row backed by finalized legacy payout evidence plus confirmed payroll and withholding
- No imported evidence for yesterday
- `demo-artifacts/demo-live.csv`: yesterday, Alice and Bob only, both USDC
- `demo-artifacts/demo-held-optional.csv`: optional held-share scenario with `worker_099`
- No old proof links or access history

## On-chain links in the product

A Solscan link is shown only after a USDC payout has a transaction signature:

- Venue payout table: the paid allocation row shows `Solscan ↗`
- Worker income ledger: the rail column shows `Solscan ↗`
- Worker connected-venue details: the latest settlement shows `Solscan ↗`

Shift approval and allocation approval remain off-chain and do not show a Solscan link. The link belongs to the atomic USDC transfer plus `SettlementRecord` transaction.
