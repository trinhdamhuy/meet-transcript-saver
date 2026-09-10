import { useState, useEffect, useMemo, useCallback } from "react";
import type { User } from "@supabase/supabase-js";
import {
  transcriptDB,
  type LocalMeeting,
  type LocalTranscriptEntry,
} from "@/lib/storage/db";
import { supabase } from "@/lib/supabase/client";
import {
  getCurrentUser,
  signOut,
  signInWithGoogle,
  onAuthStateChange,
} from "@/lib/auth/auth-service";
import {
  syncAllMeetingsToSupabase,
  forceSyncMeetingToSupabase,
} from "@/lib/sync/sync-service";
import "./App.css";

const SPEAKER_COLORS = [
  "#2563eb",
  "#059669",
  "#7c3aed",
  "#d97706",
  "#db2777",
  "#0891b2",
  "#ea580c",
  "#0d9488",
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

function formatDate(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoString;
  }
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

interface MeetingWithCount extends LocalMeeting {
  entryCount?: number;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [meetings, setMeetings] = useState<MeetingWithCount[]>([]);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(
    null,
  );
  const [transcriptEntries, setTranscriptEntries] = useState<
    LocalTranscriptEntry[]
  >([]);
  const [searchMeetingQuery, setSearchMeetingQuery] = useState("");
  const [searchTranscriptQuery, setSearchTranscriptQuery] = useState("");
  const [selectedMeetingIds, setSelectedMeetingIds] = useState<Set<string>>(
    new Set(),
  );
  const [deleteConfirmTarget, setDeleteConfirmTarget] = useState<
    string | string[] | null
  >(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // 1. Auth initialization
  useEffect(() => {
    transcriptDB.init().then(() => {
      getCurrentUser().then((u) => {
        setUser(u);
        setLoading(false);
      });
    });

    const unsubscribe = onAuthStateChange((u) => {
      setUser(u);
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  // 2. Load meetings from local IndexedDB + remote Supabase
  const loadMeetings = useCallback(async () => {
    setRefreshing(true);
    await transcriptDB.init();

    // If user is logged in, first flush any pending local unsynced meetings/transcripts to Supabase
    if (user?.id) {
      try {
        await syncAllMeetingsToSupabase(user.id);
      } catch (syncErr) {
        console.warn("[Dashboard] Auto-sync to Supabase warning:", syncErr);
      }
    }

    // Fetch local
    const localList = await transcriptDB.getAllMeetings(user?.id);

    // Fetch remote Supabase if user is logged in
    let mergedList: MeetingWithCount[] = [...localList];

    if (user?.id) {
      try {
        const { data: remoteMeetings, error } = await supabase
          .from("meetings")
          .select("*")
          .order("started_at", { ascending: false });

        if (!error && remoteMeetings) {
          const localMap = new Map(localList.map((m) => [m.id, m]));

          for (const rm of remoteMeetings) {
            if (!localMap.has(rm.id)) {
              const newMeeting: LocalMeeting = {
                id: rm.id,
                userId: rm.user_id,
                title: rm.title,
                meetUrl: rm.meet_url,
                startedAt: rm.started_at,
                endedAt: rm.ended_at,
                createdAt: rm.created_at,
              };
              await transcriptDB.saveMeeting(newMeeting);
              mergedList.push(newMeeting);
            }
          }
        }
      } catch (err) {
        console.warn("[Dashboard] Cloud sync notice:", err);
      }
    }

    // Attach entry counts
    const withCounts = await Promise.all(
      mergedList.map(async (m) => {
        const count = await transcriptDB.getMaxSequence(m.id);
        return {
          ...m,
          entryCount: count >= 0 ? count + 1 : 0,
        };
      }),
    );

    withCounts.sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );

    setMeetings(withCounts);

    // Auto-select first meeting if none selected
    if (withCounts.length > 0 && !selectedMeetingId) {
      setSelectedMeetingId(withCounts[0]!.id);
    }

    setRefreshing(false);
  }, [user?.id, selectedMeetingId]);

  const handleManualSync = async () => {
    if (!user?.id) {
      showToast("Please sign in to sync with Supabase cloud.");
      return;
    }
    setRefreshing(true);
    try {
      const result = await syncAllMeetingsToSupabase(user.id);
      await loadMeetings();
      await loadTranscriptForMeeting(selectedMeetingId);
      showToast(
        `Cloud sync complete! (${result.successCount} meetings synced)`,
      );
    } catch (err: any) {
      showToast("Cloud sync failed: " + (err?.message || "Check console"));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (user) {
      loadMeetings();
    }
  }, [user, loadMeetings]);

  // 3. Load transcript when meeting selected (from local IDB + Supabase)
  const loadTranscriptForMeeting = useCallback(
    async (meetingId: string | null) => {
      if (!meetingId) {
        setTranscriptEntries([]);
        return;
      }

      await transcriptDB.init();
      let entries = await transcriptDB.getTranscriptEntries(meetingId);

      // Query Supabase to merge any remote entries
      if (user?.id) {
        try {
          const { data: remoteEntries, error } = await supabase
            .from("transcript_entries")
            .select("*")
            .eq("meeting_id", meetingId)
            .order("sequence", { ascending: true });

          if (!error && remoteEntries && remoteEntries.length > 0) {
            const localMap = new Map(entries.map((e) => [e.id, e]));
            for (const r of remoteEntries) {
              if (!localMap.has(r.id)) {
                const item: LocalTranscriptEntry = {
                  id: r.id,
                  meetingId: r.meeting_id,
                  sequence: r.sequence,
                  speaker: r.speaker,
                  text: r.text,
                  startedAt: r.started_at,
                  synced: true,
                };
                await transcriptDB.saveTranscriptEntry(item);
                entries.push(item);
              } else {
                // If remote has updated/extended text, update local
                const local = localMap.get(r.id)!;
                if (r.text.length > local.text.length) {
                  local.text = r.text;
                  await transcriptDB.saveTranscriptEntry(local);
                }
              }
            }
            entries.sort((a, b) => a.sequence - b.sequence);
          }
        } catch (err) {
          console.warn("[Dashboard] Fetch remote transcript error:", err);
        }
      }

      setTranscriptEntries([...entries]);
    },
    [user?.id],
  );

  useEffect(() => {
    loadTranscriptForMeeting(selectedMeetingId);
  }, [selectedMeetingId, loadTranscriptForMeeting]);

  // Live auto-update: auto-refresh when tab is focused and poll periodically (every 3s)
  useEffect(() => {
    const handleFocus = () => {
      if (selectedMeetingId) {
        loadTranscriptForMeeting(selectedMeetingId);
      }
      loadMeetings();
    };

    window.addEventListener("focus", handleFocus);

    const timer = setInterval(() => {
      if (selectedMeetingId) {
        loadTranscriptForMeeting(selectedMeetingId);
      }
    }, 3000);

    return () => {
      window.removeEventListener("focus", handleFocus);
      clearInterval(timer);
    };
  }, [selectedMeetingId, loadTranscriptForMeeting, loadMeetings]);

  const selectedMeeting = useMemo(() => {
    return meetings.find((m) => m.id === selectedMeetingId) ?? null;
  }, [meetings, selectedMeetingId]);

  // Filtered meetings
  const filteredMeetings = useMemo(() => {
    if (!searchMeetingQuery.trim()) return meetings;
    const q = searchMeetingQuery.toLowerCase();
    return meetings.filter(
      (m) =>
        (m.title && m.title.toLowerCase().includes(q)) ||
        m.meetUrl.toLowerCase().includes(q),
    );
  }, [meetings, searchMeetingQuery]);

  // Filtered transcript entries
  const filteredEntries = useMemo(() => {
    if (!searchTranscriptQuery.trim()) return transcriptEntries;
    const q = searchTranscriptQuery.toLowerCase();
    return transcriptEntries.filter(
      (e) =>
        e.text.toLowerCase().includes(q) ||
        (e.speaker && e.speaker.toLowerCase().includes(q)),
    );
  }, [transcriptEntries, searchTranscriptQuery]);

  // Checkbox handlers
  const handleToggleSelectAll = () => {
    if (selectedMeetingIds.size === filteredMeetings.length) {
      setSelectedMeetingIds(new Set());
    } else {
      setSelectedMeetingIds(new Set(filteredMeetings.map((m) => m.id)));
    }
  };

  const handleToggleSelectMeeting = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = new Set(selectedMeetingIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedMeetingIds(next);
  };

  // Cascade Deletion
  const executeDelete = async (target: string | string[]) => {
    const idsToDelete = Array.isArray(target) ? target : [target];
    if (idsToDelete.length === 0) return;

    try {
      // 1. Delete from local IndexedDB (Cascade delete meeting + transcript_entries + sync_queue)
      await transcriptDB.deleteMultipleMeetingsCascade(idsToDelete);

      // 2. Delete from Supabase (PostgreSQL ON DELETE CASCADE)
      if (user) {
        const { error } = await supabase
          .from("meetings")
          .delete()
          .in("id", idsToDelete);
        if (error) {
          console.warn("Supabase cascade delete notice:", error);
        }
      }

      // 3. Update local UI state
      setMeetings((prev) => prev.filter((m) => !idsToDelete.includes(m.id)));
      if (selectedMeetingId && idsToDelete.includes(selectedMeetingId)) {
        const remaining = meetings.filter((m) => !idsToDelete.includes(m.id));
        setSelectedMeetingId(remaining[0]?.id ?? null);
        setTranscriptEntries([]);
      }

      setSelectedMeetingIds((prev) => {
        const next = new Set(prev);
        idsToDelete.forEach((id) => next.delete(id));
        return next;
      });

      showToast(`Deleted ${idsToDelete.length} meeting(s) successfully.`);
    } catch (err) {
      console.error("Failed to delete meetings:", err);
      showToast("Error deleting meetings. Please try again.");
    } finally {
      setDeleteConfirmTarget(null);
    }
  };

  // Create sample meeting for testing / demo
  const handleCreateSampleMeeting = async () => {
    if (!user) return;
    const sampleId = crypto.randomUUID();
    const sampleMeeting: LocalMeeting = {
      id: sampleId,
      userId: user.id,
      title: "Sample Sprint Planning (Demo)",
      meetUrl: "https://meet.google.com/abc-demo-xyz",
      startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      endedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    await transcriptDB.saveMeeting(sampleMeeting);

    const sampleEntries: LocalTranscriptEntry[] = [
      {
        id: crypto.randomUUID(),
        meetingId: sampleId,
        sequence: 0,
        speaker: "Alex Johnson",
        text: "Hello everyone, let's review our sprint progress for this week.",
        startedAt: new Date(Date.now() - 28 * 60 * 1000).toISOString(),
        synced: false,
      },
      {
        id: crypto.randomUUID(),
        meetingId: sampleId,
        sequence: 1,
        speaker: "Sarah Jenkins",
        text: "The backend and database synchronization tasks are fully completed.",
        startedAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
        synced: false,
      },
      {
        id: crypto.randomUUID(),
        meetingId: sampleId,
        sequence: 2,
        speaker: "Alex Johnson",
        text: "Great, the floating live transcript in Google Meet is working smoothly as well.",
        startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        synced: false,
      },
    ];

    for (const e of sampleEntries) {
      await transcriptDB.saveTranscriptEntry(e);
    }

    if (user?.id) {
      await forceSyncMeetingToSupabase(sampleId);
    }

    await loadMeetings();
    setSelectedMeetingId(sampleId);
    showToast("Created sample meeting and synced to Supabase!");
  };

  // Export handlers
  const handleCopyClipboard = () => {
    if (transcriptEntries.length === 0) return;
    const text = transcriptEntries
      .map(
        (e) =>
          `[${formatTime(e.startedAt)}] ${e.speaker || "Unknown"}: ${e.text}`,
      )
      .join("\n");

    navigator.clipboard.writeText(text).then(() => {
      showToast("Copied transcript to clipboard!");
    });
  };

  const handleDownloadFile = (
    filename: string,
    content: string,
    type: string,
  ) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Downloaded ${filename}`);
  };

  const handleExportMarkdown = () => {
    if (!selectedMeeting) return;
    const title = selectedMeeting.title || "Meeting Transcript";
    let md = `# ${title}\n\n`;
    md += `- **Date**: ${formatDate(selectedMeeting.startedAt)}\n`;
    md += `- **Meet URL**: ${selectedMeeting.meetUrl}\n`;
    md += `- **Total Lines**: ${transcriptEntries.length}\n\n`;
    md += `## Transcript\n\n`;

    transcriptEntries.forEach((e) => {
      md += `**[${formatTime(e.startedAt)}] ${e.speaker || "Unknown"}**:\n`;
      md += `> ${e.text}\n\n`;
    });

    handleDownloadFile(
      `${selectedMeeting.title || "meeting"}-transcript.md`,
      md,
      "text/markdown",
    );
  };

  const handleExportText = () => {
    if (!selectedMeeting) return;
    const text = transcriptEntries
      .map(
        (e) =>
          `[${formatTime(e.startedAt)}] ${e.speaker || "Unknown"}: ${e.text}`,
      )
      .join("\n");
    handleDownloadFile(
      `${selectedMeeting.title || "meeting"}-transcript.txt`,
      text,
      "text/plain",
    );
  };

  const handleExportJSON = () => {
    if (!selectedMeeting) return;
    const data = {
      meeting: selectedMeeting,
      entries: transcriptEntries,
    };
    handleDownloadFile(
      `${selectedMeeting.title || "meeting"}-transcript.json`,
      JSON.stringify(data, null, 2),
      "application/json",
    );
  };

  if (loading) {
    return (
      <div className="empty-detail-view">
        <div className="empty-detail-icon">⏳</div>
        <p>Loading Dashboard...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="empty-detail-view">
        <div className="empty-detail-icon">🔒</div>
        <h2>Sign In Required</h2>
        <p>
          Please sign in with your Google account to access your transcripts.
        </p>
        <button
          className="btn-action"
          style={{
            background: "#2563eb",
            color: "#fff",
            padding: "10px 20px",
            marginTop: "12px",
          }}
          onClick={() => signInWithGoogle()}
        >
          🔑 Sign in with Google
        </button>
      </div>
    );
  }

  const avatarUrl = user.user_metadata?.["avatar_url"] as string | undefined;
  const displayName =
    (user.user_metadata?.["full_name"] as string | undefined) ?? user.email;

  return (
    <div className="dashboard-app">
      {/* Top Navbar */}
      <header className="top-navbar">
        <div className="brand-section">
          <span className="brand-logo">🎙️</span>
          <h1 className="brand-title">Meet Transcript Saver</h1>
        </div>

        <div className="user-profile-section">
          {avatarUrl ? (
            <img src={avatarUrl} alt="Avatar" className="user-avatar" />
          ) : (
            <div className="user-avatar-fallback">
              {displayName?.charAt(0).toUpperCase()}
            </div>
          )}
          <span className="user-name-label">{displayName}</span>
          <button
            className="btn-signout"
            onClick={() => signOut()}
            title="Sign out"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Main Body */}
      <div className="dashboard-body">
        {/* Left Sidebar (Meeting List) */}
        <aside className="meetings-sidebar">
          <div className="sidebar-header">
            <div className="sidebar-title-row">
              <h2 className="sidebar-title">Past Meetings</h2>
              <div
                style={{ display: "flex", alignItems: "center", gap: "6px" }}
              >
                <button
                  className="btn-action"
                  style={{ padding: "3px 8px", fontSize: "11px" }}
                  onClick={handleManualSync}
                  title="Force Sync all meetings & transcripts to Supabase Cloud"
                  disabled={refreshing}
                >
                  {refreshing ? "🔄 Syncing..." : "🔄 Sync to Cloud"}
                </button>
                <span className="meeting-count-badge">
                  {filteredMeetings.length}
                </span>
              </div>
            </div>

            <div className="search-input-wrapper">
              <span className="search-icon-inside">🔍</span>
              <input
                type="text"
                className="sidebar-search-input"
                placeholder="Search by code or URL..."
                value={searchMeetingQuery}
                onChange={(e) => setSearchMeetingQuery(e.target.value)}
              />
            </div>
          </div>

          {/* Batch Actions Bar */}
          {filteredMeetings.length > 0 && (
            <div className="batch-bar">
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={
                    selectedMeetingIds.size === filteredMeetings.length &&
                    filteredMeetings.length > 0
                  }
                  onChange={handleToggleSelectAll}
                />
                <span>Select All</span>
              </label>

              {selectedMeetingIds.size > 0 && (
                <button
                  className="btn-batch-delete"
                  onClick={() =>
                    setDeleteConfirmTarget(Array.from(selectedMeetingIds))
                  }
                >
                  Delete Selected ({selectedMeetingIds.size})
                </button>
              )}
            </div>
          )}

          {/* Meeting List */}
          <div className="meetings-list-container">
            {filteredMeetings.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: "40px 16px",
                  color: "#64748b",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: "10px",
                }}
              >
                <span style={{ fontSize: "28px" }}>📭</span>
                <p style={{ margin: 0, fontSize: "13px" }}>
                  No meetings recorded yet.
                </p>
                <button
                  className="btn-action"
                  style={{
                    background: "#2563eb",
                    color: "#fff",
                    marginTop: "8px",
                  }}
                  onClick={handleCreateSampleMeeting}
                >
                  + Create Sample Meeting (Demo)
                </button>
              </div>
            ) : (
              filteredMeetings.map((m) => {
                const isSelected = m.id === selectedMeetingId;
                const isChecked = selectedMeetingIds.has(m.id);

                return (
                  <div
                    key={m.id}
                    className={`meeting-card ${isSelected ? "selected" : ""}`}
                    onClick={() => setSelectedMeetingId(m.id)}
                  >
                    <input
                      type="checkbox"
                      className="meeting-card-checkbox"
                      checked={isChecked}
                      onClick={(e) => handleToggleSelectMeeting(m.id, e)}
                      onChange={() => {}}
                    />

                    <div className="meeting-card-content">
                      <div className="meeting-card-header">
                        <span className="meeting-card-title">
                          {m.title
                            ? m.title.startsWith("http")
                              ? "Google Meet Call"
                              : m.title
                            : "Google Meet Session"}
                        </span>
                        <button
                          className="btn-card-delete"
                          title="Delete meeting"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteConfirmTarget(m.id);
                          }}
                        >
                          🗑️
                        </button>
                      </div>

                      <div className="meeting-card-meta">
                        <span>📅 {formatDate(m.startedAt)}</span>
                        {m.entryCount !== undefined && m.entryCount > 0 && (
                          <span className="meeting-card-lines">
                            💬 {m.entryCount} lines
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* Right Panel (Transcript Viewer) */}
        <main className="transcript-panel">
          {!selectedMeeting ? (
            <div className="empty-detail-view">
              <div className="empty-detail-icon">📄</div>
              <h3>Select a meeting from the left list</h3>
              <p>
                Review real-time conversation transcripts, search, or export
                data.
              </p>
            </div>
          ) : (
            <>
              {/* Detail Header */}
              <div className="detail-header">
                <div className="detail-title-group">
                  <h2 className="detail-title">
                    {selectedMeeting.title || "Google Meet Transcript"}
                  </h2>
                  <div className="detail-meta-row">
                    <span>
                      Started: {formatDate(selectedMeeting.startedAt)}
                    </span>
                    <span>•</span>
                    <a
                      href={selectedMeeting.meetUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "#2563eb", textDecoration: "none" }}
                    >
                      🔗 {selectedMeeting.meetUrl}
                    </a>
                    <span>•</span>
                    <span>{transcriptEntries.length} lines</span>
                  </div>
                </div>

                <div className="detail-actions-group">
                  <button
                    className="btn-action"
                    onClick={async () => {
                      if (selectedMeetingId) {
                        await loadMeetings();
                        await loadTranscriptForMeeting(selectedMeetingId);
                        showToast("Refreshed latest transcript data!");
                      }
                    }}
                    title="Reload latest transcript entries"
                  >
                    🔄 Refresh
                  </button>
                  <button
                    className="btn-action"
                    onClick={handleCopyClipboard}
                    title="Copy full transcript"
                  >
                    📋 Copy
                  </button>
                  <button
                    className="btn-action"
                    onClick={handleExportMarkdown}
                    title="Export as Markdown (.md)"
                  >
                    📥 .MD
                  </button>
                  <button
                    className="btn-action"
                    onClick={handleExportText}
                    title="Export as Text (.txt)"
                  >
                    📥 .TXT
                  </button>
                  <button
                    className="btn-action"
                    onClick={handleExportJSON}
                    title="Export as JSON (.json)"
                  >
                    📥 JSON
                  </button>
                  <button
                    className="btn-action btn-action-danger"
                    onClick={() => setDeleteConfirmTarget(selectedMeeting.id)}
                    title="Delete meeting & all transcript entries"
                  >
                    🗑️ Delete
                  </button>
                </div>
              </div>

              {/* Search in transcript */}
              <div className="detail-filter-bar">
                <input
                  type="text"
                  className="transcript-search-input"
                  placeholder="Search within this meeting..."
                  value={searchTranscriptQuery}
                  onChange={(e) => setSearchTranscriptQuery(e.target.value)}
                />
                <span style={{ fontSize: "12px", color: "#64748b" }}>
                  Showing {filteredEntries.length} / {transcriptEntries.length}{" "}
                  lines
                </span>
              </div>

              {/* Dialogue stream */}
              <div className="transcript-feed">
                {filteredEntries.length === 0 ? (
                  <div className="empty-detail-view">
                    <p>No transcript entries found in this meeting.</p>
                  </div>
                ) : (
                  filteredEntries.map((entry) => {
                    const speakerColor = getSpeakerColor(entry.speaker);
                    const avatarLetter = (entry.speaker || "U")
                      .charAt(0)
                      .toUpperCase();

                    return (
                      <div
                        key={entry.sequence}
                        className="transcript-bubble-row"
                      >
                        <div
                          className="bubble-avatar"
                          style={{ backgroundColor: speakerColor }}
                        >
                          {avatarLetter}
                        </div>

                        <div className="bubble-content">
                          <div className="bubble-header">
                            <span className="bubble-speaker">
                              {entry.speaker || "Unknown Speaker"}
                            </span>
                            <span className="bubble-time">
                              {formatTime(entry.startedAt)}
                            </span>
                          </div>
                          <p className="bubble-text">{entry.text}</p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
        </main>
      </div>

      {/* Confirmation Modal */}
      {deleteConfirmTarget && (
        <div
          className="modal-overlay"
          onClick={() => setDeleteConfirmTarget(null)}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Confirm Delete Meeting</h3>
            <p className="modal-text">
              Are you sure you want to delete{" "}
              {Array.isArray(deleteConfirmTarget)
                ? `${deleteConfirmTarget.length} selected meetings`
                : "this meeting"}
              ? All associated transcript entries will be permanently deleted.
            </p>
            <div className="modal-actions">
              <button
                className="btn-action"
                onClick={() => setDeleteConfirmTarget(null)}
              >
                Cancel
              </button>
              <button
                className="btn-action btn-action-danger"
                style={{ background: "#ef4444", color: "#fff" }}
                onClick={() => executeDelete(deleteConfirmTarget)}
              >
                Confirm Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div
          style={{
            position: "fixed",
            bottom: "24px",
            right: "24px",
            background: "#0f172a",
            color: "#ffffff",
            padding: "10px 18px",
            borderRadius: "8px",
            fontSize: "13px",
            boxShadow: "0 10px 15px -3px rgba(0,0,0,0.3)",
            zIndex: 2000,
          }}
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
}
