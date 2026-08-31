import { proxyAwareFetch } from "./proxyFetch.js";

// Bun's fetch uses Bun's native TLS implementation. Node remains the fallback
// so the rest of 9Router keeps its existing runtime behavior. This adapter does
// not spoof certificates or disable TLS verification.
const BUN_USER_AGENT = "codebuff/0.1.0 (darwin-arm64)";

export function isBunRuntime() {
  return typeof globalThis.Bun?.fetch === "function";
}

export async function freebuffFetch(url, options = {}, proxyOptions = null) {
  if (isBunRuntime() && !proxyOptions?.vercelRelayUrl && !proxyOptions?.url && !proxyOptions?.connectionProxyUrl) {
    return globalThis.Bun.fetch(url, options);
  }
  return proxyAwareFetch(url, options, proxyOptions);
}

export const __test__ = { isBunRuntime, BUN_USER_AGENT };
