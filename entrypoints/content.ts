import React from "react";
import ReactDOM from "react-dom/client";
import { CaptionParser, type ParsedCaption } from "@/lib/transcript/parser";
import {
  transcriptDB,
  type LocalTranscriptEntry,
  type LocalMeeting,
} from "@/lib/storage/db";
import { createSyncService, type SyncService } from "@/lib/sync/sync-service";
import {
  ensureCaptionsEnabled,
  isCaptionsActive,
  toggleCaptions,
  observeCaptionsState,
} from "@/lib/transcript/cc-controller";
import { isInMeetingCall, normalizeSpeaker } from "@/lib/transcript/selectors";
import { FloatingWidget } from "./content/FloatingWidget";
import widgetCss from "./content/FloatingWidget.css?inline";

// ─── State ────────────────────────────────────────────────────────────────────

let currentMeeting: LocalMeeting | null = null;
let captionParser: CaptionParser | null = null;
let syncService: SyncService | null = null;
let ccObserverCleanup: (() => void) | null = null;
let inCallObserverInterval: ReturnType<typeof setInterval> | null = null;

let entryCount = 0;
let syncedCount = 0;
let isRecording = false;
let isPaused = false;
let isCCActive = false;
let userManuallyStopped = false;
let entriesList: LocalTranscriptEntry[] = [];
let currentUserId: string | null = null;
let currentUserDisplayName: string | null = null;

let reactRoot: ReactDOM.Root | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getMeetUrl(): string {
  return window.location.href.split("?")[0] || window.location.href;
}

function getMeetingTitle(): string | null {
  const match = window.location.pathname.match(
    /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})$/i,
  );
  return match?.[1] ?? null;
}

function generateId(): string {
  return crypto.randomUUID();
}

function isExtensionValid(): boolean {
  try {
    return typeof chrome !== "undefined" && Boolean(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

function safeSendMessage(message: any): void {
  if (!isExtensionValid()) return;
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // Ignore invalidated extension context
  }
}

function renderUI() {
  if (!reactRoot) return;

  reactRoot.render(
    React.createElement(FloatingWidget, {
      meetingId: currentMeeting?.id ?? null,
      meetCode: getMeetingTitle(),
      isInCall: isInMeetingCall(),
      isRecording,
      isPaused,
      isCCActive,
      entryCount,
      syncedCount,
      entries: entriesList,
      onStartRecording: () => {
        if (currentUserId) startOrResumeMeeting(currentUserId);
      },
      onStopRecording: () => {
        stopMeeting(true);
      },
      onTogglePause: () => {
        togglePause();
      },
      onToggleCC: () => {
        toggleCaptions();
        isCCActive = isCaptionsActive();
        renderUI();
      },
      onOpenDashboard: () => {
        safeSendMessage({ action: "OPEN_DASHBOARD" });
      },
    }),
  );
}

// ─── Meeting Lifecycle (with Incremental Resume, Auto CC & In-Call guard) ─────

async function startOrResumeMeeting(userId: string): Promise<void> {
  if (isRecording && !isPaused) return;

  // Reset manual stop flag when explicitly starting/resuming
  userManuallyStopped = false;

  // STRICT REQUIREMENT: Only record when inside an active meeting room, NOT in lobby / home page
  if (!isInMeetingCall()) {
    console.log(
      "[MTS] Cannot start recording: User is not inside an active meeting call.",
    );
    renderUI();
    return;
  }

  // Check master recording preference
  const isMasterDisabled = await transcriptDB.getRecordingDisabled();
  if (isMasterDisabled) {
    console.log(
      "[MTS] Master recording is disabled in user preferences. Skipping start.",
    );
    return;
  }

  currentUserId = userId;
  await transcriptDB.init();

  const meetUrl = getMeetUrl();

  // 1. Check if we can resume an existing meeting in this session/URL
  let meeting = await transcriptDB.getLatestMeetingByUrl(meetUrl, userId);
  let initialSequence = 0;
  let seedTexts: string[] = [];

  if (meeting) {
    // Check if meeting was created recently (within last 8 hours)
    const hoursSinceStart =
      (Date.now() - new Date(meeting.startedAt).getTime()) / (1000 * 60 * 60);
    if (hoursSinceStart <= 8) {
      console.log(
        "[MTS] Resuming existing meeting session:",
        meeting.id,
        "started at:",
        meeting.startedAt,
      );

      // Load existing entries from DB
      const existingEntries = await transcriptDB.getTranscriptEntries(
        meeting.id,
      );
      entriesList = existingEntries;
      entryCount = existingEntries.length;

      const maxSeq = await transcriptDB.getMaxSequence(meeting.id);
      initialSequence = maxSeq >= 0 ? maxSeq + 1 : 0;

      // Seed recent texts from the last 10 entries to avoid duplicate capture on resume
      seedTexts = existingEntries.slice(-10).map((e) => e.text);

      // If meeting was marked ended, reset endedAt
      if (meeting.endedAt) {
        await transcriptDB.updateMeeting(meeting.id, { endedAt: null });
        const { supabase } = await import("@/lib/supabase/client");
        await supabase
          .from("meetings")
          .update({ ended_at: null })
          .eq("id", meeting.id);
        meeting.endedAt = null;
      }
    } else {
      meeting = undefined;
    }
  }

  if (!meeting) {
    // Create new meeting
    meeting = {
      id: generateId(),
      userId,
      title: getMeetingTitle(),
      meetUrl,
      startedAt: new Date().toISOString(),
      endedAt: null,
      createdAt: new Date().toISOString(),
    };

    await transcriptDB.saveMeeting(meeting);
    entriesList = [];
    entryCount = 0;
    syncedCount = 0;
    initialSequence = 0;
  }

  // Always ensure meeting record is persisted/synced to Supabase
  try {
    const { supabase } = await import("@/lib/supabase/client");
    const { error: meetErr } = await supabase.from("meetings").upsert({
      id: meeting.id,
      user_id: userId,
      title: meeting.title,
      meet_url: meeting.meetUrl,
      started_at: meeting.startedAt,
      ended_at: meeting.endedAt,
    });

    if (meetErr) {
      console.error(
        "[MTS] Failed to save/upsert meeting to Supabase:",
        meetErr,
      );
    }
  } catch (err) {
    console.error("[MTS] Supabase meeting upsert error:", err);
  }

  currentMeeting = meeting;
  isRecording = true;
  isPaused = false;

  // 2. Automatically enable CC in Google Meet
  await ensureCaptionsEnabled();
  isCCActive = isCaptionsActive();

  // 3. Start Sync Service
  if (!syncService) {
    syncService = createSyncService(meeting.id);
    syncService.start();
  }

  // 4. Start Caption Parser with resume sequence and user display name
  if (!captionParser) {
    captionParser = new CaptionParser(handleCaption, currentUserDisplayName);
  }
  captionParser.start({
    initialSequence,
    seedRecentTexts: seedTexts,
    currentUserDisplayName,
  });

  // 5. Observe CC state changes (auto-pause/stop if user turns off CC while recording)
  if (!ccObserverCleanup) {
    ccObserverCleanup = observeCaptionsState((active) => {
      isCCActive = active;
      // STRICT: When in IDLE / stopped state, NEVER auto-start recording upon CC change
      if (!isRecording) {
        renderUI();
        return;
      }
      if (!active && !isPaused) {
        console.log("[MTS] CC was turned off by user -> pausing recording.");
        pauseRecording();
      } else if (active && isPaused) {
        console.log("[MTS] CC was turned back on -> resuming recording.");
        resumeRecording();
      }
      renderUI();
    });
  }

  safeSendMessage({
    action: "MEETING_STARTED",
    meetingId: meeting.id,
    meetUrl: meeting.meetUrl,
  });

  renderUI();
}

function pauseRecording() {
  if (!isRecording || isPaused) return;
  isPaused = true;
  captionParser?.stop();
  syncService?.flush();
  renderUI();
}

function resumeRecording() {
  if (!isRecording || !isPaused || !currentMeeting) return;
  isPaused = false;
  const seedTexts = entriesList.slice(-10).map((e) => e.text);
  captionParser?.start({
    initialSequence: entryCount,
    seedRecentTexts: seedTexts,
    currentUserDisplayName,
  });
  renderUI();
}

function togglePause() {
  if (isPaused) {
    resumeRecording();
  } else {
    pauseRecording();
  }
}

async function stopMeeting(isManualStop: boolean = false): Promise<void> {
  if (!isRecording || !currentMeeting) return;

  if (isManualStop) {
    userManuallyStopped = true;
  }

  captionParser?.stop();
  captionParser = null;

  await syncService?.flush();
  syncService?.stop();
  syncService = null;

  if (ccObserverCleanup) {
    ccObserverCleanup();
    ccObserverCleanup = null;
  }

  const endedAt = new Date().toISOString();
  await transcriptDB.updateMeeting(currentMeeting.id, { endedAt });

  const { supabase } = await import("@/lib/supabase/client");
  await supabase
    .from("meetings")
    .update({ ended_at: endedAt })
    .eq("id", currentMeeting.id);

  safeSendMessage({
    action: "MEETING_ENDED",
    meetingId: currentMeeting.id,
  });

  isRecording = false;
  isPaused = false;
  currentMeeting = null;
  renderUI();
}

// ─── Caption Handler ──────────────────────────────────────────────────────────

function isSpeechContinuation(prevText: string, newText: string): boolean {
  const p = prevText.trim();
  const n = newText.trim();
  if (!p || !n) return false;
  if (n === p) return true;
  // If new text starts with previous text
  if (n.startsWith(p)) return true;
  // If previous text without trailing punctuation matches start of new text
  const pNoPunct = p.replace(/[.,?!:;。！？、…\s]+$/g, "");
  if (pNoPunct.length > 2 && n.startsWith(pNoPunct)) return true;
  return false;
}

async function handleCaption(parsed: ParsedCaption): Promise<void> {
  if (!currentMeeting || isPaused) return;

  const normalizedSpeaker = normalizeSpeaker(
    parsed.speaker,
    currentUserDisplayName,
  );
  const text = parsed.text.trim();
  if (!text) return;

  // Check if this is a live continuation / expansion of the last speech bubble by the same speaker
  const lastIndex = entriesList.length - 1;
  const lastEntry = lastIndex >= 0 ? entriesList[lastIndex] : null;

  if (lastEntry && lastEntry.speaker === normalizedSpeaker) {
    // 1. Exact duplicate -> ignore completely
    if (lastEntry.text.trim() === text) {
      return;
    }

    // 2. New text is an extension of the current speech turn -> update bubble in place
    if (isSpeechContinuation(lastEntry.text, text)) {
      lastEntry.text = text;
      lastEntry.synced = false;
      try {
        await transcriptDB.saveTranscriptEntry(lastEntry);
        entriesList = [...entriesList];
        renderUI();
      } catch (err) {
        console.warn("[MTS] Failed to update continuing caption bubble:", err);
      }
      return;
    }

    // 3. If previous entry already contains the full text and new text is a shorter prefix/fragment -> ignore
    if (lastEntry.text.trim().startsWith(text)) {
      return;
    }
  }

  // Otherwise, create a new separate dialogue bubble
  const nextSeq = lastEntry ? lastEntry.sequence + 1 : parsed.sequence;
  const entry: LocalTranscriptEntry = {
    id: generateId(),
    meetingId: currentMeeting.id,
    sequence: nextSeq,
    speaker: normalizedSpeaker,
    text,
    startedAt: parsed.startedAt,
    synced: false,
  };

  try {
    await transcriptDB.saveTranscriptEntry(entry);
    entriesList = [...entriesList, entry];
    entryCount = entriesList.length;
    renderUI();
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn("[MTS] Caption entry error / duplicate:", err);
    }
  }
}

// ─── In-Call State Watcher ───────────────────────────────────────────────────

function setupInCallWatcher() {
  let lastInCall = isInMeetingCall();

  inCallObserverInterval = setInterval(async () => {
    if (!isExtensionValid()) {
      if (inCallObserverInterval) clearInterval(inCallObserverInterval);
      return;
    }
    const currentInCall = isInMeetingCall();

    if (currentInCall !== lastInCall) {
      lastInCall = currentInCall;
      renderUI();

      // User just joined a meeting from the lobby
      if (
        currentInCall &&
        currentUserId &&
        !isRecording &&
        !userManuallyStopped
      ) {
        const disabled = await transcriptDB.getRecordingDisabled();
        if (!disabled) {
          console.log(
            "[MTS] Detected user entered meeting call -> starting recording.",
          );
          await startOrResumeMeeting(currentUserId);
        }
      } else if (!currentInCall) {
        // User left the meeting call -> auto-stop recording & reset manual stop flag for next meeting
        userManuallyStopped = false;
        if (isRecording) {
          console.log(
            "[MTS] Detected user left meeting call -> stopping recording.",
          );
          await stopMeeting(false);
        }
      }
    }
  }, 1500);
}

// ─── Message Handling ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.action) {
    case "MEET_DETECTED": {
      (async () => {
        const { supabase } = await import("@/lib/supabase/client");
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          currentUserId = user.id;
          currentUserDisplayName =
            (user.user_metadata?.["full_name"] as string | undefined) ??
            (user.user_metadata?.["name"] as string | undefined) ??
            user.email?.split("@")[0] ??
            null;

          const disabled = await transcriptDB.getRecordingDisabled();
          if (!disabled && !isRecording && isInMeetingCall()) {
            await startOrResumeMeeting(user.id);
          }
        }
        sendResponse({ ok: true, inCall: isInMeetingCall() });
      })();
      return true;
    }

    case "START_RECORDING": {
      (async () => {
        if (!isInMeetingCall()) {
          sendResponse({
            ok: false,
            error:
              "You must be inside an active meeting call to start recording.",
          });
          return;
        }

        const { supabase } = await import("@/lib/supabase/client");
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          currentUserId = user.id;
          currentUserDisplayName =
            (user.user_metadata?.["full_name"] as string | undefined) ??
            (user.user_metadata?.["name"] as string | undefined) ??
            user.email?.split("@")[0] ??
            null;

          await startOrResumeMeeting(user.id);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: "User not signed in" });
        }
      })();
      return true;
    }

    case "STOP_RECORDING": {
      stopMeeting(true).then(() => sendResponse({ ok: true }));
      return true;
    }

    case "PAUSE_RECORDING": {
      pauseRecording();
      sendResponse({ ok: true });
      break;
    }

    case "RESUME_RECORDING": {
      resumeRecording();
      sendResponse({ ok: true });
      break;
    }

    case "GET_STATS": {
      sendResponse({
        isInCall: isInMeetingCall(),
        isRecording,
        isPaused,
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

// Periodic sync count update
const syncInterval = setInterval(async () => {
  if (!isExtensionValid()) {
    clearInterval(syncInterval);
    return;
  }
  if (!currentMeeting || !isRecording) return;
  try {
    const unsynced = await transcriptDB.getUnsyncedEntries(currentMeeting.id);
    syncedCount = entryCount - unsynced.length;
    renderUI();
  } catch (_) {
    // ignore
  }
}, 4000);

// ─── Entry Point & UI Mount ───────────────────────────────────────────────────

export default defineContentScript({
  matches: ["https://meet.google.com/*"],
  cssInjectionMode: "ui",
  async main(ctx) {
    console.log("[MTS] Google Meet Content Script loaded.");
    await transcriptDB.init();

    isCCActive = isCaptionsActive();

    // Mount Shadow Root Floating UI
    const ui = await createShadowRootUi(ctx, {
      name: "meet-transcript-saver-ui",
      position: "inline",
      anchor: "body",
      append: "last",
      css: widgetCss,
      onMount: (container) => {
        reactRoot = ReactDOM.createRoot(container);
        renderUI();
        return reactRoot;
      },
      onRemove: (root) => {
        root?.unmount();
        reactRoot = null;
        if (inCallObserverInterval) clearInterval(inCallObserverInterval);
      },
    });

    ui.mount();
    setupInCallWatcher();

    // Check user auth and auto-start/resume if enabled AND inside a call
    const { supabase } = await import("@/lib/supabase/client");
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      currentUserId = user.id;
      currentUserDisplayName =
        (user.user_metadata?.["full_name"] as string | undefined) ??
        (user.user_metadata?.["name"] as string | undefined) ??
        user.email?.split("@")[0] ??
        null;

      const disabled = await transcriptDB.getRecordingDisabled();
      if (!disabled && isInMeetingCall()) {
        await startOrResumeMeeting(user.id);
      }
    }
  },
});
