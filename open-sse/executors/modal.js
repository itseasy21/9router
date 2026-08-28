import { DefaultExecutor } from "./default.js";

// Modal — OpenAI-compatible gateway with a per-account custom endpoint.
// baseUrl lives in credentials.providerSpecificData.baseUrl (full endpoint,
// ending in /v1/...); auth is Bearer tokenId.tokenSecret passed as apiKey.
export class ModalExecutor extends DefaultExecutor {
  constructor() {
    super("modal");
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const raw = (credentials?.providerSpecificData?.baseUrl || "").trim().replace(/\/+$/, "");
    if (!raw) throw new Error("modal requires baseUrl in providerSpecificData");
    if (raw.endsWith("/chat/completions")) return raw;
    return `${raw}/chat/completions`;
  }
}

export default ModalExecutor;