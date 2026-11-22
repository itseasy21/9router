// AWS Quick (Amazon Quick) internal chat protocol constants.
//
// These mirror the desktop client's own values (v1.2.4660) as documented by
// the magpie-aws-quick research project. Quick exposes no public chat API:
// the client talks to a bidirectional WebSocket and picks a server-routed
// model tier through `agent_mode`.

export const QUICK_SURFACE_MAC = "QUICK_WORK_DESKTOP_MAC";
export const QUICK_SURFACE_WINDOWS = "QUICK_WORK_DESKTOP_WINDOWS";

// The desktop renderer reports MAC on darwin and linux, and WINDOWS only on
// win32. Derive the same value here so a headless connection presents the
// platform the desktop app would present on this host.
export function quickSurfaceForPlatform(platform = typeof process !== "undefined" ? process.platform : "") {
  return platform === "win32" ? QUICK_SURFACE_WINDOWS : QUICK_SURFACE_MAC;
}

export const QUICK_SURFACE = quickSurfaceForPlatform();
export const QUICK_APP_VERSION = "1.2.4660";
export const QUICK_CHANNEL = "prod";

// Electron/Chromium versions in Quick 1.2.4660's default User-Agent.
export const QUICK_ELECTRON_VERSION = "43.8.7";
export const QUICK_CHROME_VERSION = "150.0.7871.250";

// Desktop session_connect feature flags (renderer `nf()` defaults).
export const QUICK_SESSION_FEATURES = Object.freeze({
  acp_first_text: 1,
  user_notification: 1,
  subtask_progress: 1,
  external_agent_sign_in: 1,
  recents_promotion: 1,
});

// The whole user_message frame is hard-capped at 64 KB server-side
// (text + system_prompt + custom_prompt + attachment data share it).
export const QUICK_FRAME_LIMIT = 60 * 1024;
export const QUICK_SYSTEM_CAP = 24 * 1024;
export const QUICK_USER_TURN_CAP = 20 * 1024;
export const QUICK_TOOL_RESULT_CAP = 16 * 1024;
export const QUICK_STALE_TOOL_CAP = 2 * 1024;
export const QUICK_IMAGE_BUDGET = 32 * 1024;
export const QUICK_IMAGE_TEXT_RESERVE = 8 * 1024;

export const QUICK_PING_MS = 25_000;
export const QUICK_CONNECT_TIMEOUT_MS = 30_000;
export const QUICK_HANDSHAKE_ACK_MS = 8_000;
export const QUICK_IDLE_TIMEOUT_MS = 180_000;
export const QUICK_SOCKET_IDLE_MS = 5 * 60_000;

// One connection per Quick account; `agent_mode` selects the tier.
export const QUICK_AGENT_MODES = Object.freeze(["fast", "balanced", "smart", "advanced"]);
export const QUICK_DEFAULT_AGENT_MODE = "smart";

export const QUICK_EFFORT_LEVELS = Object.freeze(["off", "low", "medium", "high", "max"]);

export const QUICK_EFFORT_ALIASES = Object.freeze({
  none: "off",
  minimal: "low",
  low: "low",
  medium: "medium",
  med: "medium",
  high: "high",
  xhigh: "max",
  max: "max",
  enabled: "high",
  true: "high",
  disabled: "off",
  false: "off",
});
