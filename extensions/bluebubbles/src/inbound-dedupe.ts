import os from "node:os";
import path from "node:path";
import { type ClaimableDedupe, createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";

// BlueBubbles has no sequence/ack in its webhook protocol, and its
// MessagePoller replays its ~1-week lookback window as `new-message` events
// after BB Server restarts or reconnects. Without persistent dedup, the
// gateway can reply to messages that were already handled before a restart
// (see issues #19176, #12053).
//
// TTL matches BB's lookback window so any replay is guaranteed to land on
// a remembered GUID, and the file-backed store survives gateway restarts.
const DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MEMORY_MAX_SIZE = 5_000;
const FILE_MAX_ENTRIES = 50_000;
// Cap GUID length so a malformed or hostile payload can't bloat the on-disk
// dedupe file. Real BB GUIDs are short (<64 chars); 512 is generous.
const MAX_GUID_CHARS = 512;

function resolveStateDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return override;
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), `openclaw-vitest-${process.pid}`);
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolveNamespaceFilePath(namespace: string): string {
  const safe = namespace.replace(/[^a-zA-Z0-9_-]/g, "_") || "global";
  return path.join(resolveStateDirFromEnv(), "bluebubbles", "inbound-dedupe", `${safe}.json`);
}

function buildPersistentImpl(): ClaimableDedupe {
  return createClaimableDedupe({
    ttlMs: DEDUP_TTL_MS,
    memoryMaxSize: MEMORY_MAX_SIZE,
    fileMaxEntries: FILE_MAX_ENTRIES,
    resolveFilePath: resolveNamespaceFilePath,
  });
}

function buildMemoryOnlyImpl(): ClaimableDedupe {
  return createClaimableDedupe({
    ttlMs: DEDUP_TTL_MS,
    memoryMaxSize: MEMORY_MAX_SIZE,
  });
}

let impl: ClaimableDedupe = buildPersistentImpl();

function sanitizeGuid(guid: string | undefined | null): string | null {
  const trimmed = guid?.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > MAX_GUID_CHARS) {
    return null;
  }
  return trimmed;
}

export type InboundDedupeClaim =
  | { kind: "claimed"; finalize: () => Promise<void>; release: () => void }
  | { kind: "duplicate" }
  | { kind: "inflight" }
  | { kind: "skip" };

/**
 * Attempt to claim an inbound BlueBubbles message GUID.
 *
 * - `claimed`: caller should process the message, then call `finalize()` on
 *   success (persists the GUID) or `release()` on failure (lets a later
 *   replay try again).
 * - `duplicate`: we've already committed this GUID; caller should drop.
 * - `inflight`: another claim is currently in progress; caller should drop
 *   rather than race.
 * - `skip`: GUID was missing or invalid — caller should continue processing
 *   without dedup (no finalize/release needed).
 */
export async function claimBlueBubblesInboundMessage(params: {
  guid: string | undefined | null;
  accountId: string;
  onDiskError?: (error: unknown) => void;
}): Promise<InboundDedupeClaim> {
  const normalized = sanitizeGuid(params.guid);
  if (!normalized) {
    return { kind: "skip" };
  }
  const claim = await impl.claim(normalized, {
    namespace: params.accountId,
    onDiskError: params.onDiskError,
  });
  if (claim.kind === "duplicate") {
    return { kind: "duplicate" };
  }
  if (claim.kind === "inflight") {
    return { kind: "inflight" };
  }
  return {
    kind: "claimed",
    finalize: async () => {
      await impl.commit(normalized, {
        namespace: params.accountId,
        onDiskError: params.onDiskError,
      });
    },
    release: () => {
      impl.release(normalized, { namespace: params.accountId });
    },
  };
}

/**
 * Reset inbound dedupe state between tests. Installs an in-memory-only
 * implementation so tests do not hit disk, avoiding file-lock timing issues
 * in the webhook flush path.
 */
export function _resetBlueBubblesInboundDedupForTest(): void {
  impl = buildMemoryOnlyImpl();
}
