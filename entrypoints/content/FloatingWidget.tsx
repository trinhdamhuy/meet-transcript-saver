import { useState, useEffect, useRef, useMemo } from "react";
import type { LocalTranscriptEntry } from "@/lib/storage/db";

export interface FloatingWidgetProps {
  meetingId: string | null;
  meetCode: string | null;
  isInCall: boolean;
  isRecording: boolean;
  isPaused: boolean;
  isCCActive: boolean;
  entryCount: number;
  syncedCount: number;
  entries: LocalTranscriptEntry[];
  onStartRecording: () => void;
  onStopRecording: () => void;
  onTogglePause: () => void;
  onToggleCC: () => void;
  onOpenDashboard: () => void;
}

const SPEAKER_COLORS = [
  "#3b82f6", // blue
  "#10b981", // green
  "#8b5cf6", // purple
  "#f59e0b", // amber
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#f97316", // orange
  "#14b8a6", // teal
];

function getSpeakerColor(speaker: string | null): string {
  if (!speaker) return "#64748b";
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) {
    hash = (hash << 5) - hash + speaker.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % SPEAKER_COLORS.length;
  return SPEAKER_COLORS[index] ?? "#64748b";
}

function formatTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

export function FloatingWidget({
  meetingId,
  meetCode,
  isInCall,
  isRecording,
  isPaused,
  isCCActive,
  entryCount,
  syncedCount,
  entries,
  onStartRecording,
  onStopRecording,
  onTogglePause,
  onToggleCC,
  onOpenDashboard,
}: FloatingWidgetProps) {
  const [expanded, setExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const feedRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (!feedRef.current || userScrolledUpRef.current) return;
    feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [entries.length]);

  const handleScroll = () => {
    if (!feedRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = feedRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 40;
    userScrolledUpRef.current = !isAtBottom;
  };

  const filteredEntries = useMemo(() => {
    if (!searchQuery.trim()) return entries;
    const q = searchQuery.toLowerCase();
    return entries.filter(
      (e) =>
        e.text.toLowerCase().includes(q) ||
        (e.speaker && e.speaker.toLowerCase().includes(q)),
    );
  }, [entries, searchQuery]);

  // Determine current status indicator
  let statusText = "Ready";
  let statusClass = "idle";
  let badgeClass = "idle";

  if (!isInCall) {
    statusText = "Lobby / Outside";
    statusClass = "idle";
    badgeClass = "idle";
  } else if (isRecording) {
    if (isPaused) {
      statusText = "Paused";
      statusClass = "paused";
      badgeClass = "paused";
    } else {
      statusText = "Recording";
      statusClass = "recording";
      badgeClass = "rec";
    }
  }

  if (!expanded) {
    return (
      <div className="mts-floating-container">
        <div
          className="mts-pill"
          onClick={() => setExpanded(true)}
          title="Click to open Meet Transcript Live Feed"
        >
          <div className={`mts-status-dot ${statusClass}`} />
          <span className="mts-pill-title">Transcript</span>
          {entryCount > 0 && (
            <span className="mts-pill-count">{entryCount}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mts-floating-container">
      <div className="mts-panel">
        {/* Panel Header */}
        <div className="mts-panel-header">
          <div className="mts-header-left">
            <h3 className="mts-header-title">
              Meet Transcript
              <span className={`mts-badge ${badgeClass}`}>{statusText}</span>
            </h3>
          </div>
          <div className="mts-header-actions">
            <button
              className="mts-icon-btn"
              onClick={onOpenDashboard}
              title="Open Dashboard"
            >
              📊
            </button>
            <button
              className="mts-icon-btn"
              onClick={() => setExpanded(false)}
              title="Minimize"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Controls Bar */}
        <div className="mts-controls-bar">
          <div className="mts-controls-group">
            {isRecording ? (
              <>
                <button
                  className="mts-btn mts-btn-danger"
                  onClick={onStopRecording}
                  title="Stop recording meeting"
                >
                  ⏹ Stop
                </button>
                <button
                  className="mts-btn mts-btn-secondary"
                  onClick={onTogglePause}
                  title={isPaused ? "Resume recording" : "Pause recording"}
                >
                  {isPaused ? "▶ Resume" : "⏸ Pause"}
                </button>
              </>
            ) : (
              <button
                className="mts-btn mts-btn-primary"
                onClick={onStartRecording}
                disabled={!isInCall}
                title={
                  !isInCall
                    ? "Join a meeting room to start recording"
                    : "Start recording transcript"
                }
                style={{
                  opacity: !isInCall ? 0.6 : 1,
                  cursor: !isInCall ? "not-allowed" : "pointer",
                }}
              >
                {isInCall ? "▶ Record" : "⏳ Join Call to Record"}
              </button>
            )}

            {isInCall && (
              <button
                className="mts-btn mts-btn-secondary"
                onClick={onToggleCC}
                title={
                  isCCActive
                    ? "Captions are active in Google Meet"
                    : "Turn on Captions"
                }
                style={{
                  background: isCCActive ? "#e0f2fe" : undefined,
                  color: isCCActive ? "#0369a1" : undefined,
                }}
              >
                CC: {isCCActive ? "ON" : "OFF"}
              </button>
            )}
          </div>

          <div className="mts-sync-info" title="Synced to cloud">
            ☁️ {syncedCount}/{entryCount}
          </div>
        </div>

        {/* Search Bar */}
        <div className="mts-search-box">
          <input
            type="text"
            className="mts-search-input"
            placeholder="Search dialogue..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Conversation Feed */}
        <div className="mts-feed" ref={feedRef} onScroll={handleScroll}>
          {filteredEntries.length === 0 ? (
            <div className="mts-empty-feed">
              <div className="mts-empty-icon">💬</div>
              <p className="mts-empty-text">
                {!isInCall
                  ? "You are not inside a meeting call. Click 'Join now' in Google Meet to start recording."
                  : !isCCActive
                    ? "Closed captions (CC) are off. Turn on CC to start capturing dialogue."
                    : isPaused
                      ? "Recording is paused. Click Resume to continue."
                      : isRecording
                        ? "Listening for speech... Captions will appear here."
                        : "Click Record to start capturing meeting transcripts."}
              </p>
            </div>
          ) : (
            filteredEntries.map((item) => {
              const avatarLetter = (item.speaker || "U")
                .charAt(0)
                .toUpperCase();
              const speakerBg = getSpeakerColor(item.speaker);

              return (
                <div key={item.sequence} className="mts-entry">
                  <div className="mts-entry-header">
                    <div className="mts-speaker-container">
                      <div
                        className="mts-speaker-avatar"
                        style={{ backgroundColor: speakerBg }}
                      >
                        {avatarLetter}
                      </div>
                      <span className="mts-speaker-name">
                        {item.speaker || "Unknown Speaker"}
                      </span>
                    </div>
                    <span className="mts-entry-time">
                      {formatTime(item.startedAt)}
                    </span>
                  </div>
                  <p className="mts-entry-text">{item.text}</p>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="mts-panel-footer">
          <span>Meeting: {meetCode || "Outside Call"}</span>
          <button className="mts-link-btn" onClick={onOpenDashboard}>
            Open Dashboard →
          </button>
        </div>
      </div>
    </div>
  );
}
