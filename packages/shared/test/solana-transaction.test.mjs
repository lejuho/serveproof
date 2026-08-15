import assert from "node:assert/strict";
import test from "node:test";
import {
  canReplaceTransactionBlockhash,
  isBlockhashExpired,
  shouldRebroadcastSignedTransaction,
} from "../dist/solana-transaction.js";

test("blockhash remains valid through lastValidBlockHeight", () => {
  assert.equal(isBlockhashExpired(99, 100), false);
  assert.equal(isBlockhashExpired(100, 100), false);
});

test("blockhash expires only after lastValidBlockHeight", () => {
  assert.equal(isBlockhashExpired(101, 100), true);
  assert.equal(isBlockhashExpired(101n, 100n), true);
});

test("rebroadcasts only absent/processed signatures while the blockhash is valid", () => {
  assert.equal(shouldRebroadcastSignedTransaction(null, false), true);
  assert.equal(shouldRebroadcastSignedTransaction("processed", false), true);
  assert.equal(shouldRebroadcastSignedTransaction("confirmed", false), false);
  assert.equal(shouldRebroadcastSignedTransaction(null, true), false);
});

test("permits a new blockhash only after expiry with no surviving signature", () => {
  assert.equal(canReplaceTransactionBlockhash(null, true), true);
  assert.equal(canReplaceTransactionBlockhash(null, false), false);
  assert.equal(canReplaceTransactionBlockhash("processed", true), false);
  assert.equal(canReplaceTransactionBlockhash("confirmed", true), false);
  assert.equal(canReplaceTransactionBlockhash("finalized", true), false);
});
