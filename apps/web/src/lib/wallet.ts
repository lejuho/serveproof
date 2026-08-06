import { Transaction } from "@solana/web3.js";

/**
 * Minimal injected-wallet integration (Phantom/Solflare expose a
 * window.solana provider). Enough for the venue-signing demo; can be replaced
 * with @solana/wallet-adapter without touching callers.
 */
interface InjectedSolanaProvider {
  isPhantom?: boolean;
  publicKey: { toBase58(): string } | null;
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

function getProvider(): InjectedSolanaProvider {
  const provider =
    (
      window as unknown as {
        solana?: InjectedSolanaProvider;
        phantom?: { solana?: InjectedSolanaProvider };
      }
    ).phantom?.solana ?? (window as unknown as { solana?: InjectedSolanaProvider }).solana;
  if (!provider) {
    throw new Error("Solana 지갑을 찾을 수 없습니다. Phantom 또는 Solflare를 설치하세요.");
  }
  return provider;
}

export async function connectWallet(): Promise<string> {
  const provider = getProvider();
  const { publicKey } = await provider.connect();
  return publicKey.toBase58();
}

/** Deserialize the backend's unsigned tx, sign with the wallet, return base64. */
export async function signTransactionBase64(
  unsignedBase64: string,
  expectedSigner: string,
): Promise<string> {
  const provider = getProvider();
  const { publicKey } = await provider.connect();
  if (publicKey.toBase58() !== expectedSigner) {
    throw new Error(
      `연결된 지갑(${publicKey.toBase58().slice(0, 8)}…)이 venue signer(${expectedSigner.slice(0, 8)}…)와 다릅니다.`,
    );
  }
  const raw = Uint8Array.from(atob(unsignedBase64), (c) => c.charCodeAt(0));
  const tx = Transaction.from(raw);
  const signed = await provider.signTransaction(tx);
  const serialized = signed.serialize();
  let binary = "";
  for (const byte of serialized) binary += String.fromCharCode(byte);
  return btoa(binary);
}
