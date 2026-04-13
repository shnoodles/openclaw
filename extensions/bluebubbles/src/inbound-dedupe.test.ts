import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetBlueBubblesInboundDedupForTest,
  claimBlueBubblesInboundMessage,
} from "./inbound-dedupe.js";

describe("claimBlueBubblesInboundMessage", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bb-dedupe-"));
    originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    _resetBlueBubblesInboundDedupForTest();
  });

  afterEach(async () => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("claims a new guid and rejects duplicates", async () => {
    expect(await claimBlueBubblesInboundMessage({ guid: "g1", accountId: "acc" })).toBe(true);
    expect(await claimBlueBubblesInboundMessage({ guid: "g1", accountId: "acc" })).toBe(false);
  });

  it("scopes dedupe per account", async () => {
    expect(await claimBlueBubblesInboundMessage({ guid: "g1", accountId: "a" })).toBe(true);
    expect(await claimBlueBubblesInboundMessage({ guid: "g1", accountId: "b" })).toBe(true);
  });

  it("allows messages through when guid is missing", async () => {
    expect(await claimBlueBubblesInboundMessage({ guid: undefined, accountId: "acc" })).toBe(true);
    expect(await claimBlueBubblesInboundMessage({ guid: "", accountId: "acc" })).toBe(true);
    expect(await claimBlueBubblesInboundMessage({ guid: "   ", accountId: "acc" })).toBe(true);
  });
});
