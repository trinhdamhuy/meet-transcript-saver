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
  entryCount: number;
  syncedCount: number;
  isRecording: boolean;
  meetingId: string | null;
}

// ---------------------------------------------------------------------------
// Helper: detect active tab
// ---------------------------------------------------------------------------

async function getActiveTabInfo(): Promise<{
  isOnMeet: boolean;
  tabId: number | undefined;
}> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      const isOnMeet = Boolean(tab?.url?.includes("meet.google.com"));
      resolve({ isOnMeet, tabId: tab?.id });
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
        // Content script might not be injected yet.
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
      <h2 style={styles.title}>Meet Transcript Saver</h2>
      <p style={styles.mutedText}>
        Sign in to start saving your Google Meet transcripts.
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

interface UserInfoViewProps {
  user: User;
}

function NotOnMeetView({ user }: UserInfoViewProps) {
  return (
    <div style={styles.container}>
      <UserHeader user={user} />
      <div style={styles.infoBox}>
        <p style={styles.infoText}>
          📅 Open a Google Meet to start recording transcripts.
        </p>
      </div>
    </div>
  );
}

interface RecordingViewProps {
  user: User;
  stats: TranscriptStats;
  onStop: () => void;
}

function RecordingView({ user, stats, onStop }: RecordingViewProps) {
  return (
    <div style={styles.container}>
      <UserHeader user={user} />
      <div style={styles.statsBox}>
        <div style={styles.statRow}>
          <span style={styles.statLabel}>Status</span>
          <span style={{ ...styles.statValue, color: "#22c55e" }}>
            ● Recording
          </span>
        </div>
        {stats.meetingId && (
          <div style={styles.statRow}>
            <span style={styles.statLabel}>Meeting ID</span>
            <span
              style={{
                ...styles.statValue,
                fontFamily: "monospace",
                fontSize: "11px",
              }}
            >
              {stats.meetingId.slice(0, 16)}…
            </span>
          </div>
        )}
        <div style={styles.statRow}>
          <span style={styles.statLabel}>Entries captured</span>
          <span style={styles.statValue}>{stats.entryCount}</span>
        </div>
        <div style={styles.statRow}>
          <span style={styles.statLabel}>Synced to cloud</span>
          <span style={styles.statValue}>{stats.syncedCount}</span>
        </div>
      </div>
      <button style={styles.dangerButton} onClick={onStop}>
        ⏹ Stop Recording
      </button>
    </div>
  );
}

function UserHeader({ user }: UserInfoViewProps) {
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
// Root App
// ---------------------------------------------------------------------------

const STATS_POLL_INTERVAL_MS = 2_000;

function App() {
  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [isOnMeet, setIsOnMeet] = useState(false);
  const [tabId, setTabId] = useState<number | undefined>(undefined);
  const [stats, setStats] = useState<TranscriptStats | null>(null);

  // Bootstrap: get current user, then resolve tab info.
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

  // Detect if the active tab is a Google Meet page.
  useEffect(() => {
    getActiveTabInfo().then(({ isOnMeet, tabId }) => {
      setIsOnMeet(isOnMeet);
      setTabId(tabId);
    });
  }, []);

  // Poll transcript stats while on Meet.
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
    chrome.tabs.sendMessage(tabId, { action: "STOP_RECORDING" });
  }, [tabId]);

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
  if (!isOnMeet) return <NotOnMeetView user={user} />;

  const isRecording = stats?.isRecording ?? false;
  if (isRecording && stats) {
    return <RecordingView user={user} stats={stats} onStop={handleStop} />;
  }

  // On Meet but not yet recording (or stats unavailable).
  return (
    <div style={styles.container}>
      <UserHeader user={user} />
      <div style={styles.infoBox}>
        <p style={styles.infoText}>
          🎙 Google Meet detected. Ready to capture captions!
        </p>
      </div>
      <button style={styles.primaryButton} onClick={handleStart}>
        ▶ Start Recording
      </button>
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
    fontFamily: "system-ui, sans-serif",
    fontSize: "14px",
    color: "#1f2937",
    boxSizing: "border-box",
  },
  centered: {
    width: "360px",
    minHeight: "180px",
    padding: "24px 16px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "12px",
    fontFamily: "system-ui, sans-serif",
    fontSize: "14px",
    boxSizing: "border-box",
  },
  title: {
    margin: 0,
    fontSize: "18px",
    fontWeight: 700,
    color: "#111827",
  },
  mutedText: {
    margin: 0,
    color: "#6b7280",
    textAlign: "center",
  },
  errorText: {
    margin: 0,
    color: "#ef4444",
    fontSize: "12px",
    textAlign: "center",
  },
  primaryButton: {
    padding: "10px 20px",
    background: "#4285F4",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
    width: "100%",
  },
  dangerButton: {
    padding: "10px 20px",
    background: "#ef4444",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
    width: "100%",
  },
  ghostButton: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: "16px",
    color: "#6b7280",
    padding: "4px 8px",
    marginLeft: "auto",
    flexShrink: 0,
  },
  userHeader: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px",
    background: "#f9fafb",
    borderRadius: "8px",
    border: "1px solid #e5e7eb",
  },
  avatar: {
    width: "36px",
    height: "36px",
    borderRadius: "50%",
    objectFit: "cover",
    flexShrink: 0,
  },
  avatarPlaceholder: {
    width: "36px",
    height: "36px",
    borderRadius: "50%",
    background: "#4285F4",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    fontSize: "16px",
    flexShrink: 0,
  },
  userInfo: {
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  userName: {
    fontWeight: 600,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  userEmail: {
    fontSize: "12px",
    color: "#6b7280",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  infoBox: {
    padding: "12px",
    background: "#eff6ff",
    borderRadius: "8px",
    border: "1px solid #bfdbfe",
  },
  infoText: {
    margin: 0,
    color: "#1d4ed8",
    lineHeight: "1.5",
  },
  statsBox: {
    padding: "12px",
    background: "#f0fdf4",
    borderRadius: "8px",
    border: "1px solid #bbf7d0",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  statRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  statLabel: {
    color: "#374151",
  },
  statValue: {
    fontWeight: 600,
    color: "#111827",
  },
};

export default App;
