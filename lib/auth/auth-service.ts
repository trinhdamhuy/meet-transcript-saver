import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";

/**
 * Initiates Google OAuth sign-in via Supabase.
 * Opens the Google consent screen; the user is redirected back to the extension popup on completion.
 */
export async function signInWithGoogle(): Promise<void> {
  const redirectUrl = chrome.identity.getRedirectURL();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: redirectUrl,
      skipBrowserRedirect: true,
    },
  });

  if (error) {
    console.error("[AuthService] signInWithOAuth error:", error);
    throw error;
  }

  if (!data.url) {
    throw new Error("No OAuth URL returned from Supabase");
  }

  // Use Chrome Identity WebAuthFlow to handle OAuth popup & capture redirect URL
  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: data.url,
    interactive: true,
  });

  if (!responseUrl) {
    throw new Error(
      "OAuth flow was cancelled or failed to return a response URL.",
    );
  }

  // Supabase can return tokens in the hash (#access_token=...) or query param (?code=...)
  const urlObj = new URL(responseUrl);
  const hashParams = new URLSearchParams(
    urlObj.hash.startsWith("#") ? urlObj.hash.substring(1) : urlObj.hash,
  );
  const searchParams = urlObj.searchParams;

  const errorDesc =
    hashParams.get("error_description") ||
    searchParams.get("error_description");
  if (errorDesc) {
    throw new Error(errorDesc);
  }

  const accessToken =
    hashParams.get("access_token") || searchParams.get("access_token");
  const refreshToken =
    hashParams.get("refresh_token") || searchParams.get("refresh_token");
  const code = searchParams.get("code") || hashParams.get("code");

  if (accessToken && refreshToken) {
    const { error: sessionError } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (sessionError) {
      console.error("[AuthService] setSession error:", sessionError);
      throw sessionError;
    }
  } else if (code) {
    const { error: exchangeError } =
      await supabase.auth.exchangeCodeForSession(code);
    if (exchangeError) {
      console.error(
        "[AuthService] exchangeCodeForSession error:",
        exchangeError,
      );
      throw exchangeError;
    }
  } else {
    throw new Error(
      "No tokens or code found in OAuth redirect URL: " + responseUrl,
    );
  }
}

/** Signs the current user out and clears the local Supabase session. */
export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) {
    console.error("[AuthService] signOut error:", error);
    throw error;
  }
}

/** Returns the active session, or null if the user is not authenticated. */
export async function getSession(): Promise<Session | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.error("[AuthService] getSession error:", error);
    return null;
  }
  return data.session;
}

/** Returns the currently authenticated user, or null if not signed in. */
export async function getCurrentUser(): Promise<User | null> {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error) {
    // Not authenticated — this is a normal state, not an error worth logging loudly.
    return null;
  }
  return user;
}

/**
 * Subscribes to auth state changes.
 *
 * @param callback  Called with the new User whenever the auth state changes (sign-in / sign-out).
 * @returns         A function that, when called, unsubscribes the listener.
 */
export function onAuthStateChange(
  callback: (user: User | null) => void,
): () => void {
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null);
  });

  return () => subscription.unsubscribe();
}
