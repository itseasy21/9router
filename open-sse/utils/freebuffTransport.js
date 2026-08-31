import { proxyAwareFetch } from "./proxyFetch.js";

function safeUrl(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

function safeStatus(response) {
  return `${response.status} ${response.statusText || ""}`.trim();
}

// Bun's fetch uses Bun's native TLS implementation. Node remains the fallback
// for non-Freebuff callers, but premium Freebuff traffic must not pretend that
// Node can satisfy the upstream CLI fingerprint check.
export function isBunRuntime() {
  return typeof globalThis.Bun?.fetch === "function";
}

export async function freebuffFetch(url, options = {}, proxyOptions = null) {
  const method = String(options.method || "GET").toUpperCase();
  const bun = isBunRuntime() && !proxyOptions?.vercelRelayUrl && !proxyOptions?.url && !proxyOptions?.connectionProxyUrl;
  const transport = bun ? "bun.fetch" : "proxyAwareFetch/node.fetch";
  console.info(`[FREEBUFF:TRANSPORT] ${method} ${safeUrl(url)} transport=${transport} runtime=${process.versions?.bun ? `bun/${process.versions.bun}` : `node/${process.versions?.node || "unknown"}`}`);
  try {
    const response = bun
      ? await globalThis.Bun.fetch(url, options)
      : await proxyAwareFetch(url, options, proxyOptions);
    console.info(`[FREEBUFF:RESPONSE] ${method} ${safeUrl(url)} status=${safeStatus(response)}`);
    return response;
  } catch (error) {
    console.error(`[FREEBUFF:NETWORK_ERROR] ${method} ${safeUrl(url)} error=${error?.message || String(error)}`);
    throw error;
  }
}

export const __test__ = { isBunRuntime };
