// Prints the local dev keypair (~/.config/solana/id.json) as a base58 secret
// key string for Phantom's "Import Private Key". Devnet-only dev key.
// No dependencies. Usage: node scripts/export-phantom-key.mjs [path-to-keypair.json]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      const value = digits[i] * 256 + carry;
      digits[i] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return (
    "1".repeat(zeros) +
    digits
      .reverse()
      .map((d) => ALPHABET[d])
      .join("")
  );
}

const path = process.argv[2] ?? `${homedir()}/.config/solana/id.json`;
const secretKey = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
if (secretKey.length !== 64)
  throw new Error(`Expected 64-byte secret key, got ${secretKey.length}`);
console.log(base58Encode(secretKey));
