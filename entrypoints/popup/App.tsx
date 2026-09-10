import { useState, useEffect, useCallback } from "react";
import type { User } from "@supabase/supabase-js";
import {
  signInWithGoogle,
  signOut,
  onAuthStateChange,
  getCurrentUser,
} from "@/lib/auth/auth-service";
import "./App.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TranscriptStats {
  isInCall?: boolean;
  entryCount: number;
  syncedCount: number;
  isRecording: boolean;
  isPaused?: boolean;
  meetingId: string | null;
}

// ---------------------------------------------------------------------------
// Helper: detect active tab
// ---------------------------------------------------------------------------

async function getActiveTabInfo(): Promise<{
  isOnMeet: boolean;
  tabId: number | undefined;
  meetCode: string | null;
}> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      const url = tab?.url || "";
      const isOnMeet = Boolean(url.includes("meet.google.com"));
      const match = url.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
      resolve({ isOnMeet, tabId: tab?.id, meetCode: match?.[1] ?? null });
    });
  });
}

// ---------------------------------------------------------------------------
// Helper: fetch stats from content script
// ---------------------------------------------------------------------------

async function fetchStats(tabId: number): Promise<TranscriptStats | null> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: "GET_STATS" }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response ?? null);
    });
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function LoadingView() {
  return (
    <div style={styles.centered}>
      <p style={styles.mutedText}>Loading…</p>
    </div>
  );
}

function SignInView() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async () => {
    setLoading(true);
    setError(null);
    try {
      await signInWithGoogle();
    } catch (err: any) {
      console.error("[Popup] Sign-in error:", err);
      setError(err?.message || "Sign-in failed. Please try again.");
      setLoading(false);
    }
  };

  return (
    <div style={styles.centered}>
      <div style={styles.logoBadge}>🎙</div>
      <h2 style={styles.title}>Meet Transcript Saver</h2>
      <p style={styles.mutedText}>
        Sign in to automatically capture and sync your Google Meet captions.
      </p>
      {error && <p style={styles.errorText}>{error}</p>}
      <button
        style={styles.primaryButton}
        onClick={handleSignIn}
        disabled={loading}
      >
        {loading ? "Redirecting…" : "🔑  Sign in with Google"}
      </button>
    </div>
  );
}

interface UserHeaderProps {
  user: User;
  onOpenDashboard: () => void;
}

function UserHeader({ user, onOpenDashboard }: UserHeaderProps) {
  const handleSignOut = async () => {
    await signOut();
  };

  const avatarUrl = user.user_metadata?.["avatar_url"] as string | undefined;
  const email = user.email ?? "";
  const displayName =
    (user.user_metadata?.["full_name"] as string | undefined) ?? email;

  return (
    <div style={styles.userHeader}>
      {avatarUrl ? (
        <img src={avatarUrl} alt="avatar" style={styles.avatar} />
      ) : (
        <div style={styles.avatarPlaceholder}>
          {displayName.charAt(0).toUpperCase()}
        </div>
      )}
      <div style={styles.userInfo}>
        <span style={styles.userName}>{displayName}</span>
        <span style={styles.userEmail}>{email}</span>
      </div>
      <button
        style={styles.ghostButton}
        onClick={handleSignOut}
        title="Sign out"
      >
        ↩
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Master Recording Toggle Card
// ---------------------------------------------------------------------------

interface MasterToggleCardProps {
  enabled: boolean;
  onToggle: (newVal: boolean) => void;
}

function MasterToggleCard({ enabled, onToggle }: MasterToggleCardProps) {
  return (
    <div style={styles.toggleCard}>
      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        <span style={styles.toggleTitle}>Auto-Recording</span>
        <span
          style={{
            fontSize: "11px",
            color: enabled ? "#16a34a" : "#dc2626",
            fontWeight: 600,
          }}
        >
          {enabled ? "● Active / Auto-recording" : "○ Paused / Recording Disabled"}
        </span>
      </div>
      <label style={styles.switchLabel}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          style={{ display: "none" }}
        />
        <div
          style={{
            ...styles.switchTrack,
            backgroundColor: enabled ? "#3b82f6" : "#cbd5e1",
          }}
        >
          <div
            style={{
              ...styles.switchThumb,
              transform: enabled ? "translateX(18px)" : "translateX(0px)",
            }}
          />
        </div>
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root App
// ---------------------------------------------------------------------------

const STATS_POLL_INTERVAL_MS = 1_500;

function App() {
  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [isOnMeet, setIsOnMeet] = useState(false);
  const [meetCode, setMeetCode] = useState<string | null>(null);
  const [tabId, setTabId] = useState<number | undefined>(undefined);
  const [stats, setStats] = useState<TranscriptStats | null>(null);
  const [recordingEnabled, setRecordingEnabled] = useState(true);

  // 1. Load initial storage for master toggle
  useEffect(() => {
    chrome.storage.local.get(["recording_enabled", "recordingDisabled"], (result) => {
      const disabled = result["recordingDisabled"] === true || result["recording_enabled"] === false;
      setRecordingEnabled(!disabled);
    });
  }, []);

  const handleToggleRecordingEnabled = (newVal: boolean) => {
    setRecordingEnabled(newVal);
    chrome.storage.local.set({
      recording_enabled: newVal,
      recordingDisabled: !newVal,
    });
  };

  const handleOpenDashboard = () => {
    const dashboardUrl = chrome.runtime.getURL("/dashboard.html");
    chrome.tabs.create({ url: dashboardUrl });
  };

  // 2. Bootstrap: get current user
  useEffect(() => {
    getCurrentUser().then((u) => {
      setUser(u);
      setAuthLoading(false);
    });

    const unsubscribe = onAuthStateChange((u) => {
      setUser(u);
      setAuthLoading(false);
    });

    return unsubscribe;
  }, []);

  // 3. Detect if the active tab is a Google Meet page
  useEffect(() => {
    getActiveTabInfo().then(({ isOnMeet, tabId, meetCode }) => {
      setIsOnMeet(isOnMeet);
      setTabId(tabId);
      setMeetCode(meetCode);
    });
  }, []);

  // 4. Poll transcript stats while on Meet
  const pollStats = useCallback(async () => {
    if (!tabId || !isOnMeet) return;
    const s = await fetchStats(tabId);
    if (s) setStats(s);
  }, [tabId, isOnMeet]);

  useEffect(() => {
    if (!isOnMeet || !tabId) return;
    pollStats();
    const id = setInterval(pollStats, STATS_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isOnMeet, tabId, pollStats]);

  const handleStop = useCallback(() => {
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, { action: "STOP_RECORDING" }, () => {
      pollStats();
    });
  }, [tabId, pollStats]);

  const handleStart = useCallback(() => {
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, { action: "START_RECORDING" }, () => {
      pollStats();
    });
  }, [tabId, pollStats]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (authLoading) return <LoadingView />;
  if (!user) return <SignInView />;

  const isRecording = stats?.isRecording ?? false;
  const isInCall = stats?.isInCall ?? (Boolean(meetCode) && isRecording);

  return (
    <div style={styles.container}>
      <UserHeader user={user} onOpenDashboard={handleOpenDashboard} />

      {/* Dashboard Button */}
      <button style={styles.dashboardButton} onClick={handleOpenDashboard}>
        📊 Open Full Dashboard
      </button>

      {/* Master Auto-Recording Switch */}
      <MasterToggleCard
        enabled={recordingEnabled}
        onToggle={handleToggleRecordingEnabled}
      />

      {/* Meet Status & Controls */}
      {isOnMeet ? (
        <div style={styles.meetSection}>
          <div style={styles.statsBox}>
            <div style={styles.statRow}>
              <span style={styles.statLabel}>Meeting Room</span>
              <span style={styles.codeTag}>{meetCode || "Lobby / Home"}</span>
            </div>
            <div style={styles.statRow}>
              <span style={styles.statLabel}>Call Status</span>
              <span
                style={{
                  ...styles.statValue,
                  color: isInCall ? "#16a34a" : "#64748b",
                }}
              >
                {isInCall ? "● Inside Call" : "○ In Lobby / Outside"}
              </span>
            </div>
            <div style={styles.statRow}>
              <span style={styles.statLabel}>Recording</span>
              <span
                style={{
                  ...styles.statValue,
                  color: isRecording ? "#16a34a" : "#dc2626",
                }}
              >
                {isRecording ? "● Capturing Captions" : "○ Idle / Paused"}
              </span>
            </div>
            <div style={styles.statRow}>
              <span style={styles.statLabel}>Lines Captured</span>
              <span style={styles.statValue}>{stats?.entryCount ?? 0}</span>
            </div>
            <div style={styles.statRow}>
              <span style={styles.statLabel}>Synced to Cloud</span>
              <span style={styles.statValue}>{stats?.syncedCount ?? 0}</span>
            </div>
          </div>

          {!isInCall ? (
            <div style={{ ...styles.infoBox, marginTop: "4px" }}>
              <p style={{ ...styles.infoText, fontSize: "12px" }}>
                ⏳ Join an active meeting call to start capturing live captions.
              </p>
            </div>
          ) : isRecording ? (
            <button style={styles.dangerButton} onClick={handleStop}>
              ⏹ Stop Recording
            </button>
          ) : (
            <button style={styles.primaryButton} onClick={handleStart}>
              ▶ Start / Resume Recording
            </button>
          )}
        </div>
      ) : (
        <div style={styles.infoBox}>
          <p style={styles.infoText}>
            📅 Open a Google Meet tab to automatically record and save live captions.
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: "360px",
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontSize: "14px",
    color: "#1e293b",
    backgroundColor: "#ffffff",
    boxSizing: "border-box",
  },
  centered: {
    width: "360px",
    minHeight: "220px",
    padding: "24px 16px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "12px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontSize: "14px",
    boxSizing: "border-box",
    backgroundColor: "#ffffff",
  },
  logoBadge: {
    width: "44px",
    height: "44px",
    borderRadius: "10px",
    background: "linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "22px",
    boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
  },
  title: {
    margin: 0,
    fontSize: "17px",
    fontWeight: 700,
    color: "#0f172a",
  },
  mutedText: {
    margin: 0,
    color: "#64748b",
    textAlign: "center",
    fontSize: "13px",
    lineHeight: "1.4",
  },
  errorText: {
    margin: 0,
    color: "#ef4444",
    fontSize: "12px",
    textAlign: "center",
  },
  primaryButton: {
    padding: "10px 16px",
    background: "#3b82f6",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    width: "100%",
    boxShadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    transition: "background 0.2s",
  },
  dashboardButton: {
    padding: "10px 16px",
    background: "#0f172a",
    color: "#f8fafc",
    border: "none",
    borderRadius: "8px",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    boxShadow: "0 1px 3px 0 rgb(0 0 0 / 0.1)",
  },
  dangerButton: {
    padding: "10px 16px",
    background: "#ef4444",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    width: "100%",
    transition: "background 0.2s",
  },
  ghostButton: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: "16px",
    color: "#94a3b8",
    padding: "4px 8px",
    marginLeft: "auto",
    flexShrink: 0,
  },
  userHeader: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 10px",
    background: "#f8fafc",
    borderRadius: "8px",
    border: "1px solid #e2e8f0",
  },
  avatar: {
    width: "32px",
    height: "32px",
    borderRadius: "50%",
    objectFit: "cover",
    flexShrink: 0,
  },
  avatarPlaceholder: {
    width: "32px",
    height: "32px",
    borderRadius: "50%",
    background: "#3b82f6",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    fontSize: "13px",
    flexShrink: 0,
  },
  userInfo: {
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  userName: {
    fontWeight: 600,
    fontSize: "13px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    color: "#0f172a",
  },
  userEmail: {
    fontSize: "11px",
    color: "#64748b",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  toggleCard: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 12px",
    background: "#f8fafc",
    borderRadius: "8px",
    border: "1px solid #e2e8f0",
  },
  toggleTitle: {
    fontSize: "13px",
    fontWeight: 600,
    color: "#0f172a",
  },
  switchLabel: {
    cursor: "pointer",
    display: "inline-block",
  },
  switchTrack: {
    width: "40px",
    height: "22px",
    borderRadius: "12px",
    padding: "2px",
    transition: "background-color 0.2s",
    boxSizing: "border-box",
  },
  switchThumb: {
    width: "18px",
    height: "18px",
    borderRadius: "50%",
    backgroundColor: "#ffffff",
    boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
    transition: "transform 0.2s",
  },
  meetSection: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  infoBox: {
    padding: "12px",
    background: "#f1f5f9",
    borderRadius: "8px",
    border: "1px solid #e2e8f0",
  },
  infoText: {
    margin: 0,
    color: "#475569",
    fontSize: "12px",
    lineHeight: "1.5",
  },
  statsBox: {
    padding: "12px",
    background: "#f8fafc",
    borderRadius: "8px",
    border: "1px solid #e2e8f0",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  statRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: "12px",
  },
  statLabel: {
    color: "#64748b",
  },
  statValue: {
    fontWeight: 600,
    color: "#0f172a",
  },
  codeTag: {
    fontFamily: "monospace",
    fontWeight: 600,
    background: "#e2e8f0",
    padding: "2px 6px",
    borderRadius: "4px",
    fontSize: "11px",
    color: "#1e293b",
  },
};

export default App;
