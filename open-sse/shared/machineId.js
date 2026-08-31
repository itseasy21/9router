import machineIdModule from "node-machine-id";
// CommonJS interop: node-machine-id exposes machineIdSync via module.exports,
// which Node's ESM wrapper surfaces only on the default export.
const { machineIdSync } = machineIdModule;
import crypto from "node:crypto";

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
