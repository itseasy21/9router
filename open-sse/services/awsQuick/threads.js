// Thread reuse for AWS Quick.
//
// Quick persists conversation history server-side per `thread_id`, but OpenAI
// clients resend the whole transcript every turn. We keep an incremental hash
// chain over the canonically rendered message list: an exact prefix hit means
// the client appended to a conversation we already answered, so only the new
// tail (user turns / tool results) goes upstream and Quick supplies the rest.
//
// Any edit, prune, model/effort switch, system-prompt change or toolset change
// breaks the chain, which starts a fresh thread rather than silently resuming
// a thread that no longer matches. Entries are single-use (a retry cannot
// replay a turn) and bounded (200 threads / 24h). The cache is in-memory only:
// a stale hit after a restart is impossible, only warm threads are lost.

import { createHash } from "node:crypto";
import { canonRole, textOf } from "./translate.js";

const MAX_THREADS = 200;
const TTL_MS = 24 * 60 * 60 * 1000;
const store = new Map();

function hash(value) {
  return createHash("sha256").update(String(value)).digest("base64url").slice(0, 32);
}

function canonical(message) {
  const calls = Array.isArray(message?.tool_calls)
    ? message.tool_calls
        .map((call) => {
          const name = call?.function?.name ?? call?.name ?? "";
          const args = call?.function?.arguments ?? call?.arguments ?? "";
          return `${name}:${typeof args === "string" ? args : JSON.stringify(args)}`;
        })
        .join("|")
    : "";
  return `${canonRole(message?.role)}\u0001${textOf(message?.content)}\u0001${calls}`;
}

/** Namespace the chain by account + mode/effort + system prompt + tool names. */
export function scopeFor(identity, mode, effort, systemText, toolNames) {
  return hash(
    [
      String(identity || ""),
      String(mode || ""),
      String(effort || ""),
      String(systemText || ""),
      Array.isArray(toolNames) ? toolNames.join(",") : "",
    ].join("\u0000"),
  );
}

/** h[0] = scope root, h[k] = hash over the first k messages. */
export function chainHashes(scope, messages) {
  const hashes = [hash(`0\u0000${scope}`)];
  for (const message of messages || []) {
    hashes.push(hash(`1\u0000${hashes[hashes.length - 1]}\u0000${canonical(message)}`));
  }
  return hashes;
}

function prune(now) {
  for (const [key, entry] of store) {
    if (now - entry.at > TTL_MS) store.delete(key);
  }
  while (store.size > MAX_THREADS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/**
 * Longest verified prefix hit whose remainder is only new user/tool content.
 * Consumes the entry so a client retry cannot replay the same turn.
 */
export function findReuse(scope, messages) {
  if (!Array.isArray(messages) || messages.length < 2) return null;
  prune(Date.now());
  const hashes = chainHashes(scope, messages);
  for (let index = messages.length - 1; index >= 1; index--) {
    const entry = store.get(hashes[index]);
    if (!entry) continue;
    const delta = messages.slice(index);
    if (!delta.length) continue;
    if (!delta.every((message) => ["user", "tool"].includes(canonRole(message?.role)))) continue;
    store.delete(hashes[index]);
    return { threadId: entry.threadId, delta, index };
  }
  return null;
}

/**
 * Record where the conversation stands after a completed turn. The key is the
 * chain hash of the transcript INCLUDING our reply, so the next request — whose
 * client echoes that reply — matches it as a prefix.
 */
export function rememberTurn(scope, messages, reply, threadId) {
  if (!threadId) return;
  const hashes = chainHashes(scope, [...(messages || []), reply]);
  const key = hashes[hashes.length - 1];
  store.delete(key);
  store.set(key, { threadId, at: Date.now() });
  prune(Date.now());
}

export function resetThreadCache() {
  store.clear();
}
