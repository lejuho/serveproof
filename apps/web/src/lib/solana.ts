const network = process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? "devnet";

export function solscanTxUrl(signature: string): string {
  const cluster = network === "mainnet-beta" ? "" : `?cluster=${encodeURIComponent(network)}`;
  return `https://solscan.io/tx/${encodeURIComponent(signature)}${cluster}`;
}
