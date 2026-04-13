import os from "node:os";
import path from "node:path";
import { createDedupeCache } from "openclaw/plugin-sdk/core";
import {
  type PersistentDedupe,
  createPersistentDedupe,
} from "openclaw/plugin-sdk/persistent-dedupe";

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

type DedupeImpl = Pick<PersistentDedupe, "checkAndRecord" | "clearMemory">;

function buildPersistentImpl(): DedupeImpl {
  return createPersistentDedupe({
    ttlMs: DEDUP_TTL_MS,
    memoryMaxSize: MEMORY_MAX_SIZE,
    fileMaxEntries: FILE_MAX_ENTRIES,
    resolveFilePath: resolveNamespaceFilePath,
  });
}

function buildMemoryOnlyImpl(): DedupeImpl {
  const cache = createDedupeCache({ ttlMs: DEDUP_TTL_MS, maxSize: MEMORY_MAX_SIZE });
  return {
    checkAndRecord: async (key: string, opts) => {
      const trimmed = key.trim();
      if (!trimmed) {
        return true;
      }
      const scoped = `${opts?.namespace ?? "global"}:${trimmed}`;
      return !cache.check(scoped, opts?.now);
    },
    clearMemory: () => cache.clear(),
  };
}

let impl: DedupeImpl = buildPersistentImpl();

/**
 * Record an inbound BlueBubbles message GUID and report whether it is new.
 * Returns `true` when the GUID was not previously recorded (caller should
 * proceed), `false` when it is a duplicate (caller should drop).
 * Missing/empty GUIDs return `true` (cannot dedup — allow through).
 */
export async function claimBlueBubblesInboundMessage(params: {
  guid: string | undefined | null;
  accountId: string;
  onDiskError?: (error: unknown) => void;
}): Promise<boolean> {
  const normalized = params.guid?.trim();
  if (!normalized) {
    return true;
  }
  return impl.checkAndRecord(normalized, {
    namespace: params.accountId,
    onDiskError: params.onDiskError,
  });
}

/**
 * Reset inbound dedupe state between tests. Installs an in-memory-only
 * implementation so tests do not hit disk, avoiding file-lock timing issues
 * in the webhook flush path.
 */
export function _resetBlueBubblesInboundDedupForTest(): void {
  impl = buildMemoryOnlyImpl();
}
