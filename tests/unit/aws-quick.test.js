import { beforeEach, describe, expect, it } from "vitest";
import { encodeEventFrame } from "open-sse/utils/awsEventStream.js";
import {
  isSessionFresh,
  normalizeSession,
  refreshQuickSession,
  sessionCredentialUpdates,
  sessionFromCredentials,
} from "open-sse/services/awsQuick/session.js";
import { effortFor, modeFor, pickImages, renderTranscript } from "open-sse/services/awsQuick/translate.js";
import { buildToolPreamble, createToolCallParser, normalizeTools } from "open-sse/services/awsQuick/tools.js";
import { chainHashes, findReuse, rememberTurn, resetThreadCache, scopeFor } from "open-sse/services/awsQuick/threads.js";
import { decodeDownlinkFrame, normalizeLogSink, quickAuthUsesHeader } from "open-sse/services/awsQuick/quickSocket.js";
import { AwsQuickExecutor } from "open-sse/executors/aws-quick.js";
import { buildQuickHeaders, buildQuickSessionConnect, buildQuickWsUrl, encodeQuickInputFrame } from "open-sse/services/awsQuick/fingerprint.js";
import { QUICK_SURFACE, QUICK_SURFACE_MAC, QUICK_SURFACE_WINDOWS, quickSurfaceForPlatform } from "open-sse/services/awsQuick/constants.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import { parseModel, resolveProviderAlias } from "open-sse/services/model.js";

const NOW = Math.floor(Date.now() / 1000);

function sessionFixture(overrides = {}) {
  return {
    provider: "social",
    stage: "prod",
    tenant_url: "https://cell001.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev",
    ws_host: "cell001.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev",
    jwt: "header.payload.signature",
    actor_arn: "arn:aws:quicksight:us-east-1:123:user/me",
    email: "me@example.com",
    region: "us-east-1",
    usable_until: NOW + 3600,
    tokens: { access_token: "aoa-token", refresh_token: "refresh-1", id_token: "header.payload.signature", expires_in: 3600 },
    client: {
      client_id: "client-id",
      client_secret: "client-secret",
      idc_region: "us-east-1",
      issuer_url: "https://oidc.us-east-1.amazonaws.com",
    },
    ...overrides,
  };
}

describe("aws-quick session", () => {
  it("accepts a flat session JSON pasted into apiKey", () => {
    const session = sessionFromCredentials({ apiKey: JSON.stringify(sessionFixture()) });
    expect(session.ws_host).toContain("dp.appintegrations");
    expect(session.jwt).toBe("header.payload.signature");
    expect(session.tokens.refresh_token).toBe("refresh-1");
  });

  it("accepts providerSpecificData and a magpie oauth-sessions dump", () => {
    const dump = { accounts: { "oauth-abc": sessionFixture() } };
    const session = sessionFromCredentials({ providerSpecificData: { awsQuickSession: dump } });
    expect(session.email).toBe("me@example.com");
  });

  it("derives ws_host from tenant_url and treats missing tokens as auth errors", () => {
    const fixture = sessionFixture();
    delete fixture.ws_host;
    expect(normalizeSession(fixture).ws_host).toBe("cell001.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev");
    expect(() => sessionFromCredentials({ apiKey: "not json" })).toThrow(/not valid JSON/);
    expect(() => sessionFromCredentials({})).toThrow(/not connected/);
  });

  it("reports freshness and writes refreshed credentials back into both stores", () => {
    expect(isSessionFresh(normalizeSession(sessionFixture()))).toBe(true);
    expect(isSessionFresh(normalizeSession(sessionFixture({ usable_until: NOW - 10 })))).toBe(false);
    const updates = sessionCredentialUpdates(normalizeSession(sessionFixture()), { providerSpecificData: { keep: 1 } });
    expect(JSON.parse(updates.apiKey).tokens.refresh_token).toBe("refresh-1");
    expect(updates.providerSpecificData.keep).toBe(1);
    expect(updates.providerSpecificData.awsQuickSession.ws_host).toContain("dp.appintegrations");
  });

  it("refreshes through the OIDC token endpoint and keeps rotated tokens", async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
      return new Response(
        JSON.stringify({ accessToken: "new-access", idToken: "new.jwt.token", refreshToken: "refresh-2", expiresIn: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const refreshed = await refreshQuickSession(normalizeSession(sessionFixture()), { fetchImpl });
    expect(calls[0].url).toBe("https://oidc.us-east-1.amazonaws.com/token");
    expect(calls[0].body).toMatchObject({ clientId: "client-id", grantType: "refresh_token", refreshToken: "refresh-1" });
    expect(calls[0].headers["User-Agent"]).toContain("quickwork/1.2.4660");
    expect(refreshed.jwt).toBe("new.jwt.token");
    expect(refreshed.tokens.refresh_token).toBe("refresh-2");
    expect(refreshed.usable_until).toBeGreaterThan(NOW);
  });
});

describe("aws-quick model mapping", () => {
  it("maps model ids to agent_mode and unknown ids to smart", () => {
    expect(modeFor("aws-quick/fast")).toBe("fast");
    expect(modeFor("advanced")).toBe("advanced");
    expect(modeFor("something-else")).toBe("smart");
  });

  it("maps reasoning effort spellings to Quick's levels", () => {
    expect(effortFor({ reasoning_effort: "none" })).toBe("off");
    expect(effortFor({ reasoning_effort: "xhigh" })).toBe("max");
    expect(effortFor({ thinking: { type: "enabled" } })).toBe("high");
    expect(effortFor({})).toBeUndefined();
  });
});

describe("aws-quick rendering", () => {
  it("renders a transcript with tool results and enforces the byte budget", () => {
    const tool = "x".repeat(40000);
    const out = renderTranscript(
      [
        { role: "user", content: "first" },
        { role: "assistant", content: "working" },
        { role: "tool", tool_call_id: "call-1", name: "read", content: tool },
        { role: "user", content: "again" },
      ],
      { maxBytes: 2000 },
    );
    expect(out).toContain("[tool_result read call-1]");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(2000);
    expect(renderTranscript([{ role: "user", content: "hi" }])).toBe("hi");
  });

  it("inlines only images that fit the frame budget", () => {
    const url = `data:image/png;base64,${Buffer.alloc(300).toString("base64")}`;
    const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }];
    expect(pickImages(messages, 100000).attachments).toHaveLength(1);
    const skipped = pickImages(messages, 10);
    expect(skipped.attachments).toHaveLength(0);
    expect(skipped.skipped).toBe(1);
  });

  it("builds a tool preamble and parses split tool_call blocks", () => {
    const tools = normalizeTools([
      { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string", description: "Path" } } } } },
    ]);
    expect(buildToolPreamble(tools, "auto")).toContain("<tool_call>");
    expect(buildToolPreamble(tools, "auto")).toContain("read");

    const parser = createToolCallParser();
    expect(parser.push("Sure. <tool_c").text).toBe("Sure. ");
    const rest = parser.push('all>{"name":"read","arguments":{"path":"a.js"}}</tool_call> done');
    expect(rest.calls).toEqual([{ name: "read", arguments: { path: "a.js" } }]);
    expect(rest.text).toContain("done");
    expect(parser.end().calls).toEqual([]);
  });
});

describe("aws-quick thread reuse", () => {
  beforeEach(() => resetThreadCache());

  it("reuses a thread only for an append-only tail", () => {
    const scope = scopeFor("conn-1", "smart", "high", "system", ["read"]);
    const messages = [{ role: "user", content: "hi" }];
    const reply = { role: "assistant", content: "hello" };
    rememberTurn(scope, messages, reply, "thread-1");

    const next = [...messages, reply, { role: "user", content: "next" }];
    const reuse = findReuse(scope, next);
    expect(reuse.threadId).toBe("thread-1");
    expect(reuse.delta).toEqual([{ role: "user", content: "next" }]);
    // single-use: a client retry must not replay the turn
    expect(findReuse(scope, next)).toBeNull();
  });

  it("breaks the chain on edits, scope changes, or a non-appendable tail", () => {
    const scope = scopeFor("conn-1", "smart", "high", "system", ["read"]);
    const messages = [{ role: "user", content: "hi" }];
    rememberTurn(scope, messages, { role: "assistant", content: "hello" }, "thread-1");

    expect(findReuse(scope, [{ role: "user", content: "edited" }])).toBeNull();
    expect(findReuse(scopeFor("conn-2", "smart", "high", "system", ["read"]), [{ role: "user", content: "hi" }])).toBeNull();
    expect(chainHashes(scope, messages)).toHaveLength(2);
  });
});

describe("aws-quick model routing", () => {
  it("resolves the dashboard's AQ prefix to aws-quick", () => {
    expect(parseModel("AQ/balanced")).toMatchObject({ provider: "aws-quick", model: "balanced" });
    expect(parseModel("aws-quick/balanced")).toMatchObject({ provider: "aws-quick", model: "balanced" });
  });

  it("resolves dashboard UI aliases that differ from the engine alias", () => {
    expect(resolveProviderAlias("AQ")).toBe("aws-quick");
    expect(resolveProviderAlias("pa")).toBe("perplexity-agent");
    expect(resolveProviderAlias("voyage")).toBe("voyage-ai");
  });
});

describe("aws-quick desktop wire fingerprint", () => {
  const session = { ws_host: "cell001.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev", jwt: "a b+c" };

  it("builds the desktop chat socket URL with the same params and order", () => {
    const url = buildQuickWsUrl(session, {
      outpostId: "outpost-1",
      workingSessionId: "session-1",
      agentRuntimeArnOverride: "arn:quick",
      channel: "prod",
    });
    expect(url).toBe(
      "wss://cell001.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev/streaming/quickwork-chat-bidirectional-stream" +
        `?surfaceType=${QUICK_SURFACE}&token=a%20b%2Bc&outpostId=outpost-1&workingSessionId=session-1&agentRuntimeArnOverride=arn%3Aquick&channel=prod`,
    );
  });

  it("always includes outpostId and keeps surface overrides", () => {
    const url = buildQuickWsUrl(session, { workingSessionId: "session-2", surfaceType: QUICK_SURFACE_WINDOWS });
    expect(url).toContain("&outpostId=&workingSessionId=session-2");
    expect(url).toContain("&channel=prod");
  });

  it("omits the query token when AIDP carries it in the Authorization header", () => {
    const url = buildQuickWsUrl(session, { outpostId: "outpost-1", workingSessionId: "session-3", omitToken: true });
    expect(url).not.toContain("token=");
    expect(url).toContain("surfaceType=");
  });

  it("matches the desktop platform surface and Electron 43.8.7 UA", () => {
    expect(quickSurfaceForPlatform("darwin")).toBe(QUICK_SURFACE_MAC);
    expect(quickSurfaceForPlatform("linux")).toBe(QUICK_SURFACE_MAC);
    expect(quickSurfaceForPlatform("win32")).toBe(QUICK_SURFACE_WINDOWS);
    const headers = buildQuickHeaders();
    expect(headers["User-Agent"]).toContain("quickwork/");
    expect(headers["User-Agent"]).toContain("Electron/43.8.7");
    expect(headers["User-Agent"]).toContain("Chrome/150.0.7871.250");
    expect(headers.Origin).toBeUndefined();
    expect(buildQuickHeaders({ origin: "https://quick.aws.com" }).Origin).toBe("https://quick.aws.com");
  });

  it("builds the desktop session_connect payload with its feature flags", () => {
    expect(buildQuickSessionConnect({
      actorId: null,
      surfaceType: QUICK_SURFACE_MAC,
      outpostId: "outpost-1",
      appVersion: "1.2.4660",
    })).toEqual({
      actor_id: null,
      surfaceType: QUICK_SURFACE_MAC,
      outpostId: "outpost-1",
      appVersion: "1.2.4660",
      acp_first_text: 1,
      user_notification: 1,
      subtask_progress: 1,
      external_agent_sign_in: 1,
      recents_promotion: 1,
    });
  });

  it("uses the AIDP bearer header only for enterprise cell hosts", () => {
    expect(quickAuthUsesHeader({ provider: "social", ws_host: "cell.enterprise.quick.aws.com" })).toBe(false);
    expect(quickAuthUsesHeader({ provider: "enterprise", ws_host: "cell.1.prod.us-east-1.enterprise.quick.aws.com" })).toBe(true);
    expect(quickAuthUsesHeader({ provider: "enterprise", ws_host: "cell.1.prod.us-east-1.enterprise.quick.aws.com:443" })).toBe(false);
  });

  it("wraps uplink events in the rawInputEvent/base64 envelope", () => {
    const inner = { type: "user_message", payload: { text: "hi" } };
    const frame = JSON.parse(Buffer.from(encodeQuickInputFrame(inner)).toString("utf8"));
    expect(frame.eventType).toBe("rawInputEvent");
    expect(JSON.parse(Buffer.from(frame.payload.payload, "base64").toString("utf8"))).toEqual(inner);
  });
});

describe("aws-quick executor contract", () => {
  it("normalizes the app logger module into a callable socket sink", () => {
    const lines = [];
    const sink = normalizeLogSink({ debug: (tag, message) => lines.push([tag, message]) });
    sink("connecting");
    expect(lines).toEqual([["AWS-QUICK", "connecting"]]);
    expect(normalizeLogSink(() => {})).toBeTypeOf("function");
  });

  it("returns the response envelope chatCore expects, not a bare Response", async () => {
    const executor = new AwsQuickExecutor();
    const body = { messages: [{ role: "user", content: "hi" }] };
    const result = await executor.execute({ model: "fast", body, stream: false, credentials: {}, log: {} });
    expect(result.response).toBeInstanceOf(Response);
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toMatchObject({ error: { type: "authentication_error" } });
    expect(result.url).toBe("aws-quick:websocket");
    expect(result.transformedBody).toBe(body);
  });
});

describe("aws-quick wire decoding", () => {
  it("decodes rawOutputEvent frames into inner events", () => {
    const inner = { type: "text_delta", thread_id: "t-1", payload: { delta: "hi" } };
    const frame = encodeEventFrame(
      { ":message-type": "event", ":event-type": "rawOutputEvent" },
      { payload: Buffer.from(JSON.stringify(inner), "utf8").toString("base64") },
    );
    expect(decodeDownlinkFrame(frame).event).toEqual(inner);
  });

  it("surfaces protocol error frames", () => {
    const frame = encodeEventFrame(
      { ":message-type": "error", ":error-code": "UnauthorizedException", ":error-message": "token expired" },
      null,
    );
    expect(decodeDownlinkFrame(frame).error).toEqual({ code: "UnauthorizedException", message: "token expired" });
  });
});
