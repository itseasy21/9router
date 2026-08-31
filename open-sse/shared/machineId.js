import * as machineIdModule from "node-machine-id";
import crypto from "node:crypto";

// node-machine-id is CommonJS. Under webpack the named export resolves
// normally, under plain Node ESM it only exists on the default export —
// support both so neither the Next build nor direct Node execution breaks.
const machineIdSync =
  machineIdModule.machineIdSync || machineIdModule.default?.machineIdSync;

let cachedRawId = null;

function loadRawMachineId() {
  if (cachedRawId) return cachedRawId;
  try {
    cachedRawId = machineIdSync();
  } catch {
    cachedRawId = crypto.randomUUID();
  }
  return cachedRawId;
}

export async function getConsistentMachineId(salt = "endpoint-proxy-salt") {
  const rawId = loadRawMachineId();
  return crypto.createHash("sha256").update(rawId + salt).digest("hex").substring(0, 16);
}
