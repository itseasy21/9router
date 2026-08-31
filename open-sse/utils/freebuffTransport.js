import { proxyAwareFetch } from "./proxyFetch.js";

function safeUrl(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

function isDiagnosticEnabled() {
  return process.env.DEBUG_FREEBUFF === "1" || process.env.NODE_ENV !== "production";
}

export function isBunRuntime() {
  return typeof globalThis.Bun?.fetch === "function";
}

export async function freebuffFetch(url, options = {}, proxyOptions = null) {
  const method = String(options.method || "GET").toUpperCase();
  const bun = isBunRuntime() && !proxyOptions?.vercelRelayUrl && !proxyOptions?.url && !proxyOptions?.connectionProxyUrl;
  const transport = bun ? "bun.fetch" : "proxyAwareFetch/node.fetch";
  if (isDiagnosticEnabled()) console.info(`[FREEBUFF:TRANSPORT] ${method} ${safeUrl(url)} transport=${transport}`);
  try {
    const response = bun
      ? await globalThis.Bun.fetch(url, options)
      : await proxyAwareFetch(url, options, proxyOptions);
    if (isDiagnosticEnabled()) console.info(`[FREEBUFF:RESPONSE] ${method} ${safeUrl(url)} status=${response.status}`);
    return response;
  } catch (error) {
    console.error(`[FREEBUFF:NETWORK_ERROR] ${method} ${safeUrl(url)} error=${error?.message || String(error)}`);
    throw error;
  }
}

export const __test__ = { isBunRuntime };
