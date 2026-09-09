import { CaptionParser, type ParsedCaption } from "@/lib/transcript/parser";
import {
  transcriptDB,
  type LocalTranscriptEntry,
  type LocalMeeting,
} from "@/lib/storage/db";
import { createSyncService, type SyncService } from "@/lib/sync/sync-service";

// ─── State ────────────────────────────────────────────────────────────────────

let currentMeeting: LocalMeeting | null = null;
let captionParser: CaptionParser | null = null;
let syncService: SyncService | null = null;
let entryCount = 0;
let syncedCount = 0;
let isRecording = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getMeetUrl(): string {
  return window.location.href;
}

function getMeetingTitle(): string | null {
  // Google Meet puts the meeting code in the URL path: /abc-defg-hij
  const match = window.location.pathname.match(
    /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})$/i,
  );
  return match?.[1] ?? null;
}

function generateId(): string {
  return crypto.randomUUID();
}

// ─── Meeting Lifecycle ────────────────────────────────────────────────────────

async function startMeeting(userId: string): Promise<void> {
  if (isRecording) return;

  await transcriptDB.init();

  const meeting: LocalMeeting = {
    id: generateId(),
    userId,
    title: getMeetingTitle(),
    meetUrl: getMeetUrl(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    createdAt: new Date().toISOString(),
  };

  // Save meeting to Supabase (fire and forget — local store is source of truth)
  await transcriptDB.saveMeeting(meeting);

  // Also upsert meeting row to Supabase
  const { supabase } = await import("@/lib/supabase/client");
  const { error: meetErr } = await supabase.from("meetings").upsert({
    id: meeting.id,
    user_id: userId,
    title: meeting.title,
    meet_url: meeting.meetUrl,
    started_at: meeting.startedAt,
  });

  if (meetErr) {
    console.error(
      "[MTS] Failed to save meeting to Supabase:",
      JSON.stringify(meetErr, null, 2),
    );
  }

  currentMeeting = meeting;
  entryCount = 0;
  syncedCount = 0;
  isRecording = true;

  // Start sync service
  syncService = createSyncService(meeting.id);
  syncService.start();

  // Start caption parser
  captionParser = new CaptionParser(handleCaption);
  captionParser.start();

  // Notify background
  chrome.runtime.sendMessage({
    action: "MEETING_STARTED",
    meetingId: meeting.id,
    meetUrl: meeting.meetUrl,
  });

  console.log("[MTS] Recording started for meeting:", meeting.id);
}

async function stopMeeting(): Promise<void> {
  if (!isRecording || !currentMeeting) return;

  // Stop parser first (no new captions)
  captionParser?.stop();
  captionParser = null;

  // Final sync flush before stopping
  await syncService?.flush();
  syncService?.stop();
  syncService = null;

  // Mark meeting as ended
  const endedAt = new Date().toISOString();
  await transcriptDB.updateMeeting(currentMeeting.id, { endedAt });

  const { supabase } = await import("@/lib/supabase/client");
  await supabase
    .from("meetings")
    .update({ ended_at: endedAt })
    .eq("id", currentMeeting.id);

  chrome.runtime.sendMessage({
    action: "MEETING_ENDED",
    meetingId: currentMeeting.id,
  });

  console.log("[MTS] Recording stopped for meeting:", currentMeeting.id);

  currentMeeting = null;
  isRecording = false;
}

// ─── Caption Handler ──────────────────────────────────────────────────────────

async function handleCaption(parsed: ParsedCaption): Promise<void> {
  if (!currentMeeting) return;

  const entry: LocalTranscriptEntry = {
    id: generateId(),
    meetingId: currentMeeting.id,
    sequence: parsed.sequence,
    speaker: parsed.speaker,
    text: parsed.text,
    startedAt: parsed.startedAt,
    synced: false,
  };

  try {
    await transcriptDB.saveTranscriptEntry(entry);
    entryCount++;
  } catch (err) {
    // Sequence duplicate — already saved, skip silently
    if (import.meta.env.DEV) {
      console.warn("[MTS] Caption entry duplicate or error:", err);
    }
  }
}

// ─── Message Handling (from popup / background) ───────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.action) {
    case "MEET_DETECTED": {
      // Background notified us a Meet tab is active — auto-start if user is logged in
      (async () => {
        const { supabase } = await import("@/lib/supabase/client");
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user && !isRecording) {
          await startMeeting(user.id);
        }
        sendResponse({ ok: true });
      })();
      return true; // keep channel open for async sendResponse
    }

    case "START_RECORDING": {
      (async () => {
        const { supabase } = await import("@/lib/supabase/client");
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          await startMeeting(user.id);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: "User not signed in" });
        }
      })();
      return true;
    }

    case "STOP_RECORDING": {
      stopMeeting().then(() => sendResponse({ ok: true }));
      return true;
    }

    case "GET_STATS": {
      sendResponse({
        isRecording,
        entryCount,
        syncedCount,
        meetingId: currentMeeting?.id ?? null,
      });
      break;
    }

    default:
      break;
  }
});

// Track synced count by listening to sync-service indirectly via DB state
// Refresh syncedCount every 5s
setInterval(async () => {
  if (!currentMeeting || !isRecording) return;
  try {
    const unsynced = await transcriptDB.getUnsyncedEntries(currentMeeting.id);
    syncedCount = entryCount - unsynced.length;
  } catch (_) {
    // ignore
  }
}, 5000);

// ─── Entry Point ──────────────────────────────────────────────────────────────

export default defineContentScript({
  matches: ["https://meet.google.com/*"],
  async main() {
    console.log("[MTS] Content script loaded on Google Meet.");
    await transcriptDB.init();

    // Auto-start if user is already authenticated
    const { supabase } = await import("@/lib/supabase/client");
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      await startMeeting(user.id);
    }
  },
});
