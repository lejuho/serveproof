/**
 * A transaction remains valid through lastValidBlockHeight (inclusive).
 * A new blockhash/signature is safe only after the cluster advances past it.
 */
export function isBlockhashExpired(
  currentBlockHeight: number | bigint,
  lastValidBlockHeight: number | bigint,
): boolean {
  return BigInt(currentBlockHeight) > BigInt(lastValidBlockHeight);
}

export type TransactionConfirmationStatus = "processed" | "confirmed" | "finalized" | null;

/** Re-send only the same signature, only while its blockhash can still land. */
export function shouldRebroadcastSignedTransaction(
  confirmationStatus: TransactionConfirmationStatus,
  blockhashExpired: boolean,
): boolean {
  return !blockhashExpired && (confirmationStatus === null || confirmationStatus === "processed");
}

/**
 * A fresh blockhash is safe only when the old one expired without a surviving
 * processed/confirmed/finalized signature.
 */
export function canReplaceTransactionBlockhash(
  confirmationStatus: TransactionConfirmationStatus,
  blockhashExpired: boolean,
): boolean {
  return blockhashExpired && confirmationStatus === null;
}
