import { transcriptDB } from "@/lib/storage/db";
import { supabase } from "@/lib/supabase/client";

const SYNC_INTERVAL_MS = 3_000;
const BATCH_SIZE = 20;
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

const isDev = import.meta.env.DEV;

function devLog(...args: unknown[]): void {
  console.log("[SyncService]", ...args);
}

function devError(...args: unknown[]): void {
  console.error("[SyncService]", ...args);
}

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Uploads a single batch of entries with exponential backoff retry.
 * Ensures the parent meeting row exists in Supabase first.
 * Returns true on success, false after exhausting retries.
 */
async function uploadBatchWithRetry(
  meetingId: string,
  batch: Awaited<ReturnType<typeof transcriptDB.getUnsyncedEntries>>,
): Promise<boolean> {
  // 1. Ensure parent meeting exists in Supabase
  try {
    const localMeeting = await transcriptDB.getMeeting(meetingId);
    if (localMeeting) {
      const { error: meetErr } = await supabase.from("meetings").upsert({
        id: localMeeting.id,
        user_id: localMeeting.userId,
        title: localMeeting.title,
        meet_url: localMeeting.meetUrl,
        started_at: localMeeting.startedAt,
        ended_at: localMeeting.endedAt,
      });
      if (meetErr) {
        devError(
          "Failed to upsert parent meeting record to Supabase:",
          meetErr,
        );
        throw meetErr;
      }
    }
  } catch (err) {
    devError("Error ensuring meeting exists in Supabase:", err);
  }

  // 2. Prepare transcript payload with primary key ID
  const payload = batch.map((entry) => ({
    id: entry.id,
    meeting_id: entry.meetingId,
    sequence: entry.sequence,
    speaker: entry.speaker ?? null,
    text: entry.text,
    started_at: entry.startedAt,
  }));

  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    try {
      // Upsert by primary key "id" - supported natively by Supabase / Postgres
      const { error } = await supabase
        .from("transcript_entries")
        .upsert(payload, { onConflict: "id" });

      if (error) {
        devError("Supabase upsert error on transcript_entries:", error);
        throw error;
      }

      // Mark entries as synced in local DB only on confirmed success.
      const sequences = batch.map((e) => e.sequence);
      await transcriptDB.markEntriesSynced(meetingId, sequences);
      devLog(
        `Synced batch of ${batch.length} entries for meeting ${meetingId}`,
      );
      return true;
    } catch (err: any) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        devError(
          `Failed to sync batch after ${MAX_RETRIES} retries:`,
          err?.message || err,
          err?.details,
          err?.hint,
        );
        return false;
      }

      const backoff = Math.min(
        BASE_BACKOFF_MS * 2 ** (attempt - 1),
        MAX_BACKOFF_MS,
      );
      devLog(
        `Retrying batch (attempt ${attempt}/${MAX_RETRIES}) in ${backoff}ms...`,
      );
      await sleep(backoff);
    }
  }

  return false;
}

export class SyncService {
  private readonly meetingId: string;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Guard against concurrent flush calls. */
  private flushing = false;

  constructor(meetingId: string) {
    this.meetingId = meetingId;
  }

  /** Start the interval-based sync (every 3 s). No-op if already running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    devLog(`Starting sync for meeting ${this.meetingId}`);
    this.intervalId = setInterval(() => {
      this.flush().catch((err) => devError("Interval flush error:", err));
    }, SYNC_INTERVAL_MS);
  }

  /** Stop the interval. In-flight flushes are allowed to complete. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    devLog(`Stopped sync for meeting ${this.meetingId}`);
  }

  /** Force an immediate sync cycle. Safe to call concurrently — re-entrant calls are skipped. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const unsynced = await transcriptDB.getUnsyncedEntries(this.meetingId);
      if (unsynced.length === 0) return;

      devLog(`Flushing ${unsynced.length} unsynced entries...`);

      // Split into batches of BATCH_SIZE.
      for (let i = 0; i < unsynced.length; i += BATCH_SIZE) {
        const batch = unsynced.slice(i, i + BATCH_SIZE);
        await uploadBatchWithRetry(this.meetingId, batch);
      }
    } catch (err) {
      devError("flush() error:", err);
    } finally {
      this.flushing = false;
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}

/** Factory — creates a new SyncService per meeting. */
export function createSyncService(meetingId: string): SyncService {
  return new SyncService(meetingId);
}

/**
 * Manually forces an immediate sync of a specific meeting and its entries to Supabase.
 */
export async function syncMeetingNow(meetingId: string): Promise<boolean> {
  return forceSyncMeetingToSupabase(meetingId);
}

/**
 * Force syncs an entire meeting and all its transcript entries to Supabase,
 * regardless of whether they were previously marked as synced locally.
 */
export async function forceSyncMeetingToSupabase(
  meetingId: string,
): Promise<boolean> {
  try {
    const allEntries = await transcriptDB.getTranscriptEntries(meetingId);
    if (allEntries.length === 0) {
      // Still ensure parent meeting row is created on Supabase
      const localMeeting = await transcriptDB.getMeeting(meetingId);
      if (localMeeting) {
        await supabase.from("meetings").upsert({
          id: localMeeting.id,
          user_id: localMeeting.userId,
          title: localMeeting.title,
          meet_url: localMeeting.meetUrl,
          started_at: localMeeting.startedAt,
          ended_at: localMeeting.endedAt,
        });
      }
      return true;
    }

    // Reuse uploadBatchWithRetry to upload all entries in batches
    for (let i = 0; i < allEntries.length; i += BATCH_SIZE) {
      const batch = allEntries.slice(i, i + BATCH_SIZE);
      const success = await uploadBatchWithRetry(meetingId, batch);
      if (!success) return false;
    }

    return true;
  } catch (err) {
    devError("forceSync error:", err);
    return false;
  }
}

/**
 * Syncs all local meetings and transcript entries for a user to Supabase.
 */
export async function syncAllMeetingsToSupabase(
  userId: string,
): Promise<{ successCount: number; errorCount: number }> {
  let successCount = 0;
  let errorCount = 0;

  const localMeetings = await transcriptDB.getAllMeetings(userId);
  for (const m of localMeetings) {
    try {
      const ok = await forceSyncMeetingToSupabase(m.id);
      if (ok) {
        successCount++;
      } else {
        errorCount++;
      }
    } catch (err) {
      devError(`Failed to sync meeting ${m.id}:`, err);
      errorCount++;
    }
  }

  return { successCount, errorCount };
}
