import crypto from "crypto";
import { FREEBUFF_CONFIG } from "../constants/oauth.js";

// Freebuff fingerprint device-login flow (mirrors the official CLI in
// CodebuffAI/freebuff, cli/src/login/login-flow.ts):
//   1) POST /api/auth/cli/code {fingerprintId} → {loginUrl, fingerprintHash, expiresAt}
//   2) User signs in at loginUrl on freebuff.com (code lives ~1h)
//   3) GET /api/auth/cli/status?fingerprintId&fingerprintHash&expiresAt
//      → 401 while pending; {user:{id,email,name,authToken,...}} once authorized
// fingerprintHash is computed SERVER-side (SHA-256 over serverSecret +
// fingerprintId + expiresAt) and must be stored verbatim and echoed back.
// There is no refresh token: authToken is long-lived; expiry means re-login.
const freebuff = {
  config: FREEBUFF_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const fingerprintId = crypto.randomUUID();
    const response = await fetch(config.loginCodeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ fingerprintId }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Device code request failed: ${error}`);
    }

    const data = await response.json();
    return {
      // Map onto the device-code vocabulary the shared poll loop expects.
      device_code: data.fingerprintId ?? fingerprintId,
      user_code: null,
      verification_uri: data.loginUrl,
      verification_uri_complete: data.loginUrl,
      expires_in: data.expiresAt
        ? Math.max(0, Math.floor((new Date(data.expiresAt).getTime() - Date.now()) / 1000))
        : undefined,
      interval: 5,
      // Echoed verbatim by pollToken → mapTokens (server verifies the hash chain).
      _freebuffFingerprintId: data.fingerprintId ?? fingerprintId,
      _freebuffFingerprintHash: data.fingerprintHash,
      _freebuffExpiresAt: data.expiresAt,
    };
  },
  pollToken: async (config, deviceCode, _codeVerifier, extraData) => {
    const fingerprintId = extraData?._freebuffFingerprintId ?? deviceCode;
    const fingerprintHash = extraData?._freebuffFingerprintHash;
    const expiresAt = extraData?._freebuffExpiresAt;
    if (!fingerprintHash || !expiresAt) {
      return {
        ok: false,
        data: { error: "invalid_request", error_description: "Missing fingerprintHash/expiresAt from device code response" },
      };
    }

    const params = new URLSearchParams({
      fingerprintId,
      fingerprintHash,
      expiresAt,
    });
    const response = await fetch(`${config.loginStatusUrl}?${params.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    // 401 = not yet authorized → surface as authorization_pending so the
    // shared poll loop keeps waiting instead of failing.
    if (response.status === 401) {
      return { ok: true, data: { error: "authorization_pending" } };
    }
    if (!response.ok) {
      let errorText;
      try {
        errorText = await response.text();
      } catch {
        errorText = response.statusText;
      }
      return { ok: false, data: { error: "invalid_response", error_description: errorText } };
    }

    let data;
    try {
      data = await response.json();
    } catch {
      return { ok: false, data: { error: "invalid_response", error_description: "non-json status response" } };
    }

    if (!data?.user?.authToken) {
      return { ok: true, data: { error: "authorization_pending" } };
    }
    return { ok: true, data };
  },
  mapTokens: (tokens) => ({
    accessToken: tokens.user.authToken,
    // No refresh token exists — expired authToken means re-login (reconnect UX).
    refreshToken: null,
    expiresIn: null,
    name: tokens.user.name || tokens.user.email,
    displayName: tokens.user.name || tokens.user.email,
    email: tokens.user.email || null,
    providerSpecificData: {
      authMethod: "device_login",
      freebuffUserId: tokens.user.id,
      // Required verbatim for status polling / logout (server-side HMAC chain).
      fingerprintId: tokens.user.fingerprintId,
      fingerprintHash: tokens.user.fingerprintHash,
      fingerprintExpiresAt: tokens.user.expiresAt,
    },
  }),
};

export default freebuff;
