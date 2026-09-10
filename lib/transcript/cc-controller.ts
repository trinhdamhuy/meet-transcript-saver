/**
 * @file lib/transcript/cc-controller.ts
 * @description Controls and monitors Google Meet's built-in Closed Captions (CC) state.
 */

import { findCaptionsRegion } from "@/lib/transcript/selectors";

/**
 * Finds Google Meet's Closed Captions toggle button in the DOM.
 */
export function findCaptionsButton(): HTMLButtonElement | null {
  // Query by standard accessibility labels and attributes used in Google Meet
  const candidates = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  );

  for (const btn of candidates) {
    const ariaLabel = (btn.getAttribute("aria-label") ?? "").toLowerCase();
    const tooltip = (
      btn.getAttribute("data-tooltip") ??
      btn.getAttribute("data-tooltip-title") ??
      ""
    ).toLowerCase();
    const keyshortcut = (
      btn.getAttribute("aria-keyshortcuts") ?? ""
    ).toLowerCase();

    // Check for "captions" or "phụ đề" (Vietnamese UI) or "subtítulos", etc.
    if (
      ariaLabel.includes("caption") ||
      ariaLabel.includes("phụ đề") ||
      ariaLabel.includes("subtítulo") ||
      ariaLabel.includes("untertitel") ||
      ariaLabel.includes("sous-titres") ||
      tooltip.includes("caption") ||
      tooltip.includes("phụ đề") ||
      keyshortcut === "c"
    ) {
      return btn;
    }
  }

  return null;
}

/**
 * Checks if Closed Captions are currently active on Google Meet.
 */
export function isCaptionsActive(): boolean {
  // 1. If captions region exists in the DOM, CC is active
  if (findCaptionsRegion() !== null) {
    return true;
  }

  // 2. Check CC button aria-pressed / aria-checked state
  const btn = findCaptionsButton();
  if (btn) {
    const pressed = btn.getAttribute("aria-pressed");
    const checked = btn.getAttribute("aria-checked");
    if (pressed === "true" || checked === "true") {
      return true;
    }
  }

  return false;
}

/**
 * Toggles Closed Captions on or off.
 */
export function toggleCaptions(): boolean {
  const btn = findCaptionsButton();
  if (btn) {
    btn.click();
    return true;
  }

  // Fallback: Dispatch keyboard shortcut 'c'
  try {
    const eventDown = new KeyboardEvent("keydown", {
      key: "c",
      code: "KeyC",
      bubbles: true,
      cancelable: true,
    });
    const eventUp = new KeyboardEvent("keyup", {
      key: "c",
      code: "KeyC",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(eventDown);
    document.dispatchEvent(eventUp);
    return true;
  } catch (err) {
    console.warn("[CCController] Failed to dispatch CC keyboard event:", err);
    return false;
  }
}

/**
 * Ensures Closed Captions are enabled. If not active, triggers activation.
 * Returns a Promise that resolves to true if active/activated, or false if timed out.
 */
export async function ensureCaptionsEnabled(
  maxWaitMs: number = 3000,
): Promise<boolean> {
  if (isCaptionsActive()) {
    return true;
  }

  toggleCaptions();

  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (isCaptionsActive()) {
      return true;
    }
  }

  return isCaptionsActive();
}

/**
 * Observes CC state changes (captions turned on or off by the user).
 * Returns an unsubscribe / cleanup function.
 */
export function observeCaptionsState(
  onStateChange: (active: boolean) => void,
): () => void {
  let lastState = isCaptionsActive();
  let observer: MutationObserver | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const checkState = () => {
    const currentState = isCaptionsActive();
    if (currentState !== lastState) {
      lastState = currentState;
      onStateChange(currentState);
    }
  };

  try {
    observer = new MutationObserver(() => {
      checkState();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-pressed", "aria-checked", "aria-label", "class"],
    });
  } catch (err) {
    console.warn("[CCController] Failed to create MutationObserver:", err);
  }

  // Backup polling every 1.5s in case mutations are suppressed
  pollTimer = setInterval(checkState, 1500);

  return () => {
    observer?.disconnect();
    if (pollTimer) clearInterval(pollTimer);
  };
}
