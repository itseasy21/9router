// Wire fingerprint for the AWS Quick desktop chat transport.
//
// Quick authorizes the socket with a bearer token in the URL and identifies the
// client through the `surfaceType`, `appVersion` and `channel` query params plus
// the `session_connect` payload. The desktop app is Electron, so the handshake
// also carries an Electron-style User-Agent and the browser's cache headers.
//
// Everything here is overridable per connection
// (providerSpecificData.awsQuickUserAgent / awsQuickOrigin / awsQuickSurface /
// awsQuickAppVersion / awsQuickChannel) so a client build change can be
// matched without editing the executor.

import {
  QUICK_APP_VERSION,
  QUICK_CHANNEL,
  QUICK_CHROME_VERSION,
  QUICK_ELECTRON_VERSION,
  QUICK_SESSION_FEATURES,
  QUICK_SURFACE,
} from "./constants.js";

const PLATFORM_TOKENS = {
  darwin: "Macintosh; Intel Mac OS X 10_15_7",
  win32: "Windows NT 10.0; Win64; x64",
  linux: "X11; Linux x86_64",
};

/** Electron-style desktop UA (the Quick desktop app is the reference client). */
export function defaultQuickUserAgent(appVersion = QUICK_APP_VERSION) {
  const platform = PLATFORM_TOKENS[typeof process !== "undefined" ? process.platform : ""] || PLATFORM_TOKENS.linux;
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) quickwork/${appVersion} Chrome/${QUICK_CHROME_VERSION} Electron/${QUICK_ELECTRON_VERSION} Safari/537.36`;
}

/** Handshake headers, matching what the desktop client's WebSocket sends. */
export function buildQuickHeaders({ userAgent, origin, acceptLanguage, extra } = {}) {
  return {
    "User-Agent": userAgent || defaultQuickUserAgent(),
    "Accept-Language": acceptLanguage || "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    ...(origin ? { Origin: origin } : {}),
    ...(extra || {}),
  };
}

/**
 * Exact chat socket URL used by the desktop client. The order matches the
 * renderer's `Gx` builder: surfaceType, token (unless AIDP moves it to the
 * Authorization header), outpostId, workingSessionId, agentRuntimeArnOverride,
 * replayContext, channel.
 */
export function buildQuickWsUrl(
  session,
  {
    surfaceType = QUICK_SURFACE,
    channel = QUICK_CHANNEL,
    outpostId = "",
    workingSessionId = crypto.randomUUID(),
    agentRuntimeArnOverride,
    replayContext,
    omitToken = false,
  } = {},
) {
  if (!session?.ws_host || !session?.jwt) {
    throw new Error("AWS Quick session has no ws_host/id_token");
  }
  const base = /^wss?:\/\//i.test(session.ws_host) ? session.ws_host.replace(/\/+$/, "") : `wss://${session.ws_host}`;
  return (
    `${base}/streaming/quickwork-chat-bidirectional-stream` +
    `?surfaceType=${encodeURIComponent(surfaceType)}` +
    (omitToken ? "" : `&token=${encodeURIComponent(session.jwt)}`) +
    `&outpostId=${encodeURIComponent(outpostId)}` +
    `&workingSessionId=${encodeURIComponent(workingSessionId)}` +
    (agentRuntimeArnOverride ? `&agentRuntimeArnOverride=${encodeURIComponent(agentRuntimeArnOverride)}` : "") +
    (replayContext ? `&replayContext=${encodeURIComponent(replayContext)}` : "") +
    (channel ? `&channel=${encodeURIComponent(channel)}` : "")
  );
}

/** Desktop `session_connect` payload (`{actor_id, ...tf(), ...nf()}`). */
export function buildQuickSessionConnect({
  actorId,
  surfaceType = QUICK_SURFACE,
  outpostId = "",
  appVersion = QUICK_APP_VERSION,
} = {}) {
  return {
    actor_id: actorId ?? null,
    surfaceType,
    outpostId,
    appVersion,
    ...QUICK_SESSION_FEATURES,
  };
}

/**
 * Uplink frame envelope: binary UTF-8 JSON wrapping the inner protocol event in
 * base64 — exactly what the desktop renderer sends.
 */
export function encodeQuickInputFrame(inner) {
  const payload = Buffer.from(JSON.stringify(inner), "utf8").toString("base64");
  return new TextEncoder().encode(JSON.stringify({ eventType: "rawInputEvent", payload: { payload } }));
}
