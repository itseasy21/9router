// Global test safety net — prevents tests from polluting the real user DB.
//
// History: several test files (db fixtures with seed-*/clash-*/ord-* names,
// zed-live-models "guard-*" connections) wrote to ~/.9router before per-file
// DATA_DIR isolation was added, leaving 350+ fixture connections that showed
// up as phantom "seed-*" providers on the Usage topology. Those tests are
// self-isolating now, but any future test that forgets to set DATA_DIR would
// silently hit the real DB again.
//
// This defaults DATA_DIR to a per-run temp dir. Tests that need their own
// isolation can still set process.env.DATA_DIR themselves (the per-file
// mkdtemp pattern) — it is only assigned here when unset or empty.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-test-data-"));
}
