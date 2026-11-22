// AWS Quick session handling.
//
// Quick is authenticated with an OIDC id_token obtained from the Amazon Quick
// sign-in flow (`https://quick.aws.com/sn`). A session record carries the
// token, the tenant WebSocket host, the actor ARN and the OIDC client used to
// refresh it. We accept that record verbatim from:
//   1. providerSpecificData.awsQuickSession (object or JSON string)
//   2. the connection's apiKey (JSON string; the cookie-style connection row)
//   3. a magpie-aws-quick `oauth-sessions.json` dump ({accounts:{key:session}})
//
// Multiple accounts are just multiple connections — each row keeps its own
// session and refresh token, and the gateway's normal account rotation/fallback
// applies across them.

import { defaultQuickUserAgent } from "./fingerprint.js";

const APP_VERSION = "1.2.4660";
const REFRESH_LEAD_SEC = 120;
const tokenEndpointCache = new Map();

export class QuickSessionError extends Error {
  constructor(message, { kind = "auth", status = 401 } = {}) {
    super(message);
    this.name = "QuickSessionError";
    this.kind = kind;
    this.status = status;
  }
}

function decodeJwt(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Some dumps store milliseconds; the wire uses epoch seconds.
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

function normalizeUserInfo(raw) {
  const source = raw && typeof raw.userInfo === "object" ? raw.userInfo : raw;
  const pick = (...keys) => {
    for (const key of keys) {
      const value = source?.[key];
      if (value != null && value !== "") return String(value).split(/\s+/).join(" ").trim();
    }
    return "";
  };
  return {
    email: pick("email", "emailAddress"),
    display_name: pick("displayName", "display_name"),
    account_name: pick("accountName", "account_name"),
    aws_account_id: pick("awsAccountId", "aws_account_id", "accountId"),
    user_arn: pick("userArn", "user_arn"),
  };
}

function pickAccount(raw, requestedKey) {
  const accounts = raw?.accounts;
  if (!accounts || typeof accounts !== "object") return raw;
  const key = asString(requestedKey);
  if (key && accounts[key]) return accounts[key];
  const first = Object.values(accounts).find((entry) => entry && typeof entry === "object");
  return first || raw;
}

/**
 * Normalize any supported credential shape into the session record we use.
 * Unknown fields are preserved so a serialize round-trip does not lose data.
 */
export function normalizeSession(input, { accountKey } = {}) {
  const raw = pickAccount(input, accountKey);
  if (!raw || typeof raw !== "object") {
    throw new QuickSessionError("AWS Quick credentials must be a JSON object");
  }
  const tokens = raw.tokens && typeof raw.tokens === "object" ? raw.tokens : {};
  const client = raw.client && typeof raw.client === "object" ? raw.client : {};
  const userInfo = raw.user_info && typeof raw.user_info === "object" ? raw.user_info : {};

  const idToken = asString(raw.jwt || raw.id_token || raw.idToken || tokens.id_token || tokens.idToken);
  const accessToken = asString(tokens.access_token || tokens.accessToken || raw.access_token || raw.accessToken);
  const refreshToken = asString(tokens.refresh_token || tokens.refreshToken || raw.refresh_token || raw.refreshToken);
  const jwt = idToken || accessToken;

  let wsHost = asString(raw.ws_host || raw.wsHost);
  const tenantUrl = asString(raw.tenant_url || raw.tenantUrl);
  if (!wsHost && tenantUrl) {
    try {
      wsHost = new URL(tenantUrl).host;
    } catch {
      /* tenant_url without scheme is handled below */
    }
  }
  if (!wsHost && tenantUrl && !/^https?:\/\//i.test(tenantUrl)) {
    try {
      wsHost = new URL(`https://${tenantUrl}`).host;
    } catch {
      /* leave empty and fail validation below */
    }
  }
  wsHost = wsHost.replace(/^wss?:\/\//i, "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");

  const claims = decodeJwt(idToken || accessToken);
  const expiresIn = Number(tokens.expires_in ?? tokens.expiresIn ?? raw.expires_in ?? 0) || 0;
  const obtainedAt = toSeconds(raw.obtained_at || raw.obtainedAt) || Math.floor(Date.now() / 1000);
  let usableUntil = toSeconds(raw.usable_until || raw.usableUntil);
  if (!usableUntil) {
    usableUntil = expiresIn ? obtainedAt + expiresIn : toSeconds(claims.exp);
  }

  return {
    provider: asString(raw.provider) || "social",
    stage: asString(raw.stage) || "prod",
    tenant_url: tenantUrl,
    ws_host: wsHost,
    jwt,
    actor_arn: asString(raw.actor_arn || raw.actorArn || userInfo.user_arn),
    aws_account_id: asString(raw.aws_account_id || raw.awsAccountId || userInfo.aws_account_id),
    account_name: asString(raw.account_name || raw.accountName || userInfo.account_name),
    email: asString(raw.email || userInfo.email),
    display_name: asString(raw.display_name || raw.displayName || userInfo.display_name),
    region: asString(raw.region || client.idc_region) || "us-east-1",
    usable_until: usableUntil,
    obtained_at: obtainedAt,
    outpost_id: asString(raw.outpost_id || raw.outpostId),
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      expires_in: expiresIn,
    },
    client: {
      client_id: asString(client.client_id || client.clientId || raw.client_id || raw.clientId),
      client_secret: asString(client.client_secret || client.clientSecret || raw.client_secret || raw.clientSecret),
      idc_region: asString(client.idc_region || client.idcRegion || raw.idc_region || raw.idcRegion),
      issuer_url: asString(client.issuer_url || client.issuerUrl || raw.issuer_url || raw.issuerUrl),
    },
  };
}

/** Extract + validate the session stored on a connection's credentials. */
export function sessionFromCredentials(credentials) {
  const psd = credentials?.providerSpecificData || {};
  const stored = psd.awsQuickSession ?? credentials?.apiKey;
  if (!stored) {
    throw new QuickSessionError(
      "AWS Quick is not connected: add a connection and paste the session JSON (id_token + ws_host, plus refresh_token/client for auto-refresh).",
    );
  }
  let parsed = stored;
  if (typeof stored === "string") {
    const text = stored.trim();
    if (!text) throw new QuickSessionError("AWS Quick session JSON is empty");
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new QuickSessionError(
        "AWS Quick credentials are not valid JSON. Paste the session object (id_token, ws_host, refresh_token, client), not the browser cookie header.",
      );
    }
  }
  const session = normalizeSession(parsed, { accountKey: psd.awsQuickAccountKey || psd.accountKey });
  if (!session.jwt) {
    throw new QuickSessionError("AWS Quick session has no id_token/access_token — sign in again and re-paste the session JSON.");
  }
  if (!session.ws_host) {
    throw new QuickSessionError("AWS Quick session has no ws_host (or tenant_url to derive it from) — re-paste the session JSON.");
  }
  return session;
}

export function isSessionFresh(session) {
  if (!session?.jwt) return false;
  if (!session.usable_until) return true;
  return session.usable_until - Math.floor(Date.now() / 1000) > REFRESH_LEAD_SEC;
}

async function tokenEndpointFor(session, fetchImpl) {
  const issuer = asString(session?.client?.issuer_url);
  if (issuer) {
    if (!tokenEndpointCache.has(issuer)) {
      let endpoint = null;
      try {
        const res = await fetchImpl(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`, {
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) endpoint = (await res.json())?.token_endpoint || null;
      } catch {
        /* fall back to the regional endpoint */
      }
      tokenEndpointCache.set(issuer, endpoint);
    }
    const cached = tokenEndpointCache.get(issuer);
    if (cached) return cached;
  }
  const region = session?.client?.idc_region || session?.region || "us-east-1";
  return `https://oidc.${region}.amazonaws.com/token`;
}

/**
 * Refresh the session with grantType=refresh_token. OIDC refresh tokens can
 * rotate, so the caller must persist the returned session (see
 * sessionCredentialUpdates) or the next refresh will be rejected.
 */
export async function refreshQuickSession(session, { fetchImpl = fetch, log, userAgent } = {}) {
  const refreshToken = session?.tokens?.refresh_token;
  if (!refreshToken) {
    throw new QuickSessionError("AWS Quick session expired and has no refresh_token — reconnect the account.");
  }
  const endpoint = await tokenEndpointFor(session, fetchImpl);
  const ua = userAgent || defaultQuickUserAgent();
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": ua },
      body: JSON.stringify({
        clientId: session.client?.client_id || "",
        clientSecret: session.client?.client_secret || "",
        grantType: "refresh_token",
        refreshToken,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new QuickSessionError(`AWS Quick token refresh failed: ${error.message}`, { kind: "http", status: 502 });
  }
  const text = await res.text();
  if (!res.ok) {
    throw new QuickSessionError(`AWS Quick token refresh failed (HTTP ${res.status}): ${text.slice(0, 200)}`, {
      kind: "http",
      status: res.status === 400 || res.status === 401 ? 401 : 502,
    });
  }
  let token;
  try {
    token = JSON.parse(text);
  } catch {
    throw new QuickSessionError("AWS Quick token refresh returned invalid JSON", { kind: "http", status: 502 });
  }
  const accessToken = asString(token.accessToken || token.access_token);
  const idToken = asString(token.idToken || token.id_token);
  if (!accessToken && !idToken) {
    throw new QuickSessionError("AWS Quick token refresh returned no access token — reconnect the account.");
  }
  const expiresIn = Number(token.expiresIn ?? token.expires_in ?? 0) || 0;
  const claims = decodeJwt(idToken);
  const now = Math.floor(Date.now() / 1000);
  const refreshed = {
    ...session,
    jwt: idToken || accessToken,
    tokens: {
      ...session.tokens,
      access_token: accessToken || session.tokens.access_token,
      id_token: idToken || session.tokens.id_token,
      refresh_token: asString(token.refreshToken || token.refresh_token) || refreshToken,
      expires_in: expiresIn,
    },
    usable_until: expiresIn ? now + expiresIn : toSeconds(claims.exp) || session.usable_until,
    obtained_at: now,
  };

  // Best-effort identity refresh, same call the client/reference makes after a
  // token refresh. Failure must never invalidate the refreshed session.
  try {
    const base = String(session.tenant_url || "").replace(/\/+$/, "");
    if (base) {
      const infoRes = await fetchImpl(`${base}/integration/quick-work/user-info`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${accessToken || idToken}`,
          "User-Agent": ua,
        },
        body: "{}",
        signal: AbortSignal.timeout(8000),
      });
      if (infoRes.ok) {
        const info = normalizeUserInfo(await infoRes.json());
        refreshed.email = info.email || refreshed.email;
        refreshed.display_name = info.display_name || refreshed.display_name;
        refreshed.account_name = info.account_name || refreshed.account_name;
        refreshed.aws_account_id = refreshed.aws_account_id || info.aws_account_id;
        refreshed.actor_arn = refreshed.actor_arn || info.user_arn;
      }
    }
  } catch {
    /* identity refresh is best-effort */
  }

  log?.debug?.("AWS-QUICK", "session refreshed");
  return refreshed;
}

/** Session record in the shape the reference tool persists (and we accept back). */
export function serializeSession(session) {
  return {
    provider: session.provider,
    stage: session.stage,
    tenant_url: session.tenant_url,
    ws_host: session.ws_host,
    jwt: session.jwt,
    actor_arn: session.actor_arn,
    aws_account_id: session.aws_account_id,
    account_name: session.account_name,
    email: session.email,
    display_name: session.display_name,
    region: session.region,
    usable_until: session.usable_until,
    obtained_at: session.obtained_at,
    outpost_id: session.outpost_id || undefined,
    tokens: { ...session.tokens },
    client: { ...session.client },
  };
}

/**
 * Credential patch for a refreshed session. `apiKey` carries the serialized
 * session (that is where the connection stored it), and the same object is
 * mirrored into providerSpecificData so both persistence paths stay in sync.
 */
export function sessionCredentialUpdates(session, credentials = {}) {
  const stored = serializeSession(session);
  return {
    apiKey: JSON.stringify(stored),
    accessToken: session.jwt,
    refreshToken: session.tokens?.refresh_token || undefined,
    providerSpecificData: {
      ...(credentials.providerSpecificData || {}),
      awsQuickSession: stored,
    },
  };
}

export function describeSession(session) {
  return session.email || session.display_name || session.account_name || session.actor_arn || session.ws_host;
}

export { APP_VERSION };
