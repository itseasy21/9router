/**
 * GLM Coding Plan usage (international + China regions)
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U, parseResetTime } from "./shared.js";

// GLM quota endpoints (region-aware) — url from registry transport.usage
const GLM_QUOTA_URLS = {
  international: U("glm").url,
  china: U("glm-cn").url,
};

/**
 * Z.AI Coding Plan (OAuth JWT) usage — per-model token buckets from billing/balance.
 */
async function getGlmCodingPlanUsage(jwtToken, proxyOptions = null) {
  const headers = {
    Authorization: `Bearer ${jwtToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  try {
    const [billingRes, balanceRes] = await Promise.all([
      proxyAwareFetch("https://zcode.z.ai/api/v1/zcode-plan/billing/current", { headers }, proxyOptions),
      proxyAwareFetch("https://zcode.z.ai/api/v1/zcode-plan/billing/balance", { headers }, proxyOptions).catch(() => null),
    ]);

    if (!billingRes.ok) {
      if (billingRes.status === 401) {
        return { message: "Z.AI Coding Plan token invalid or expired." };
      }
      return { message: `Coding Plan billing API error (${billingRes.status}).` };
    }

    const billingJson = await billingRes.json();
    const billingData = billingJson?.data || billingJson;
    const balanceJson = balanceRes?.ok ? await balanceRes.json() : null;
    const balanceData = balanceJson?.data || balanceJson;

    const plans = Array.isArray(billingData?.plans) ? billingData.plans : [];
    const planName = plans[0]?.name || billingData?.planName || "Coding Plan";

    const quotas = {};
    const balances = Array.isArray(balanceData?.balances) ? balanceData.balances : [];

    for (const bal of balances) {
      if (!bal?.show_name) continue;

      const total = Number(bal.total_units) || 0;
      const used = Number(bal.used_units) || 0;
      const remainingUnits = Number(bal.remaining_units);
      const remaining = Number.isFinite(remainingUnits)
        ? Math.max(0, remainingUnits)
        : Math.max(0, total - used);

      quotas[bal.show_name] = {
        used,
        total,
        remainingPercentage: total > 0 ? Math.round((remaining / total) * 100) : 0,
        resetAt: parseResetTime(bal.expires_at),
        unlimited: false,
        unit: "token",
      };
    }

    if (Object.keys(quotas).length === 0) {
      return {
        plan: planName,
        message: "Coding Plan connected. No per-model balance data available.",
        quotas: {},
      };
    }

    return { plan: planName, quotas };
  } catch (error) {
    return { message: `GLM Coding Plan error: ${error.message}` };
  }
}

/**
 * GLM usage — OAuth Coding Plan JWT or API key quota APIs.
 * Supports both TOKENS_LIMIT and CREDIT_LIMIT and dynamic intervals (e.g. session 5h, weekly 7d).
 */
export async function getGlmUsage(connection, proxyOptions = null) {
  const provider = connection?.provider || "glm";
  const apiKey = connection?.apiKey;
  const providerSpecificData = connection?.providerSpecificData || {};
  const useCodingPlan =
    providerSpecificData.useCodingPlan &&
    (providerSpecificData.zcodeJwtToken || connection?.accessToken);

  if (useCodingPlan) {
    const zcodeJwt = providerSpecificData.zcodeJwtToken || connection.accessToken;
    return getGlmCodingPlanUsage(zcodeJwt, proxyOptions);
  }

  if (!apiKey) {
    return { message: "GLM API key not available." };
  }

  const region = provider === "glm-cn" ? "china" : "international";
  const quotaUrl = GLM_QUOTA_URLS[region];

  try {
    const response = await proxyAwareFetch(
      quotaUrl,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (!response.ok) {
      if (response.status === 401) {
        return { message: "GLM API key invalid or expired." };
      }
      return { message: `GLM quota API error (${response.status}).` };
    }

    const json = await response.json();
    const data = json?.data && typeof json.data === "object" ? json.data : {};
    const limits = Array.isArray(data.limits) ? data.limits : [];
    const quotas = {};

    for (const limit of limits) {
      // 1. Accept both TOKENS_LIMIT and CREDIT_LIMIT from GLM API
      if (!limit || (limit.type !== "TOKENS_LIMIT" && limit.type !== "CREDIT_LIMIT")) continue;
      const usedPercent = Number(limit.percentage) || 0;
      const resetMs = Number(limit.nextResetTime) || 0;
      const remaining = Math.max(0, 100 - usedPercent);

      // 2. Map key dynamically based on type and period (unit) to avoid overwriting
      let key = "session";
      if (limit.unit === 3) {
        key = `Session (${limit.number}h)`;
      } else if (limit.unit === 6) {
        key = "Weekly (7d)";
      } else if (limit.type === "TOKENS_LIMIT") {
        key = "Tokens";
      } else {
        key = `Limit (${limit.number})`;
      }

      quotas[key] = {
        used: usedPercent,
        total: 100,
        remaining,
        remainingPercentage: remaining,
        resetAt: resetMs > 0 ? new Date(resetMs).toISOString() : null,
        unlimited: false,
      };
    }

    const levelRaw = typeof data.level === "string" ? data.level : "";
    const plan = levelRaw
      ? levelRaw.charAt(0).toUpperCase() + levelRaw.slice(1).toLowerCase()
      : "Unknown";

    return { plan, quotas };
  } catch (error) {
    return { message: `GLM error: ${error.message}` };
  }
}
