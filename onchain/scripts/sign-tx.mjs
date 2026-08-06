// Signs a base64 unsigned transaction with the local dev wallet (venue authority).
// Usage: node sign-tx.mjs <base64>  → prints signed base64
import { Keypair, Transaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const kp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))),
);
const tx = Transaction.from(Buffer.from(process.argv[2], "base64"));
tx.partialSign(kp);
process.stdout.write(tx.serialize().toString("base64"));
