import { isSessionFresh, refreshQuickSession, sessionCredentialUpdates, sessionFromCredentials } from "./session.js";
import { QuickSocket } from "./quickSocket.js";

/**
 * Validate a connection the way the dashboard's "Test" button needs: parse the
 * session, refresh it if expired, then open the Quick WebSocket and wait for
 * the session handshake. No chat turn is billed.
 */
export async function probeAwsQuickCredentials(credentials, { log } = {}) {
  let session;
  try {
    session = sessionFromCredentials(credentials);
  } catch (error) {
    return { valid: false, error: error.message };
  }

  let refreshed;
  if (!isSessionFresh(session) && session.tokens.refresh_token) {
    try {
      session = await refreshQuickSession(session, { log });
      refreshed = sessionCredentialUpdates(session, credentials);
    } catch {
      /* fall through and let the stored token decide */
    }
  }

  const socket = new QuickSocket({
    getSession: async () => ({ ws_host: session.ws_host, jwt: session.jwt, actor_arn: session.actor_arn }),
    outpostId: credentials?.providerSpecificData?.awsQuickOutpostId || session.outpost_id || "",
    log,
  });

  try {
    await socket.connect();
    return { valid: true, error: null, ...(refreshed ? { refreshed: true, newTokens: refreshed } : {}) };
  } catch (error) {
    return {
      valid: false,
      error: error?.message || String(error),
      ...(refreshed ? { refreshed: true, newTokens: refreshed } : {}),
    };
  } finally {
    await socket.close().catch(() => {});
  }
}
