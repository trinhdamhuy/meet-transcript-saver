/**
 * lib/transcript/selectors.ts
 *
 * Google Meet caption DOM extraction — structural approach.
 *
 * WHY NOT USE CLASS NAMES?
 * Google Meet uses minified/obfuscated CSS class names (e.g. "nMcdL", "NWpY1d",
 * "ygicle"). These are regenerated on every deploy and cannot be relied upon.
 *
 * WHAT IS STABLE?
 * 1. ARIA attributes: `role="region"` + `aria-label="Captions"` — stable because
 *    they serve accessibility purposes and Google cannot easily remove them.
 * 2. DOM structure: within the captions region, each caption block is a direct
 *    child <div>. Inside each block, the speaker name is a <span> and the caption
 *    text is the last significant <div> containing the transcript text.
 */

// ─── Stable root selector ─────────────────────────────────────────────────────

export const CAPTIONS_REGION_SELECTOR =
  'div[role="region"][aria-label="Captions"]';

// ─── In-Call Detection ────────────────────────────────────────────────────────

/**
 * Returns true if the user is currently inside an active meeting call.
 * Returns false on home page, landing page, green room/lobby, or post-call screen.
 */
export function isInMeetingCall(): boolean {
  // 1. Must match meeting code pattern /abc-defg-hij
  const match = window.location.pathname.match(
    /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})$/i,
  );
  if (!match) return false;

  // 2. If "Call ended" or "Return to home screen" is present, not in call
  if (
    document.querySelector('div[data-call-ended="true"]') ||
    document.querySelector('button[aria-label*="Rejoin" i]') ||
    document.querySelector('button[aria-label*="Tham gia lại" i]')
  ) {
    return false;
  }

  // 3. If pre-join lobby buttons like "Join now" or "Ask to join" exist, not yet in call
  const joinBtn = Array.from(document.querySelectorAll("button")).find((btn) => {
    const txt = (btn.textContent ?? "").trim().toLowerCase();
    return (
      txt === "join now" ||
      txt === "ask to join" ||
      txt === "tham gia ngay" ||
      txt === "yêu cầu tham gia"
    );
  });
  if (joinBtn) {
    return false;
  }

  // 4. In-call indicators: leave call button, captions region, or video grid
  const leaveBtn = document.querySelector(
    'button[aria-label*="Leave call" i], button[aria-label*="Rời khỏi cuộc gọi" i], button[data-tooltip*="Leave" i], button[data-tooltip*="Rời khỏi" i], button[jsname="CQylAd"]',
  );
  if (leaveBtn) return true;

  if (findCaptionsRegion()) return true;

  // Default: if path is /abc-defg-hij and no lobby buttons
  return true;
}

// ─── Region finder ────────────────────────────────────────────────────────────

/**
 * Finds the captions region element in the document.
 * Returns null when captions are not enabled / not yet rendered.
 */
export function findCaptionsRegion(): Element | null {
  return document.querySelector(CAPTIONS_REGION_SELECTOR);
}

// ─── Caption block detection ─────────────────────────────────────────────────

/**
 * Returns all caption blocks currently visible inside the captions region.
 * Filters out UI controls (e.g., "Jump to bottom" button, icon buttons).
 */
export function getCaptionBlocks(region: Element): Element[] {
  return Array.from(region.children).filter((el) => {
    if (el.tagName !== "DIV" || !el.textContent?.trim()) return false;
    if (el.querySelector("button") || el.matches("button")) return false;
    if (
      el.textContent.includes("Jump to bottom") ||
      el.textContent.includes("arrow_downward")
    ) {
      return false;
    }
    return true;
  });
}

// ─── Speaker Normalization ───────────────────────────────────────────────────

/**
 * Replaces generic self-pronouns ("You", "Bạn", "Vous", etc.) rendered by Google Meet
 * with the user's actual display name.
 */
export function normalizeSpeaker(
  rawSpeaker: string | null,
  userName?: string | null,
): string | null {
  if (!rawSpeaker) return userName || null;

  const trimmed = rawSpeaker.trim();
  const lower = trimmed.toLowerCase();

  // Common Google Meet self pronouns across languages
  if (
    lower === "you" ||
    lower === "bạn" ||
    lower === "vous" ||
    lower === "tú" ||
    lower === "du" ||
    lower === "você" ||
    lower === "tu"
  ) {
    return userName || trimmed;
  }

  return trimmed;
}

// ─── Data extraction from a single block ─────────────────────────────────────

/**
 * Extracts { speaker, text } from a caption block using structural heuristics.
 */
export function extractBlockData(
  block: Element,
  currentUserDisplayName?: string | null,
): { speaker: string | null; text: string } | null {
  if (block.matches("button") || block.querySelector("button")) return null;
  if (
    block.textContent?.includes("Jump to bottom") ||
    block.textContent?.includes("arrow_downward")
  ) {
    return null;
  }

  // ── Speaker ────────────────────────────────────────────────────────────────
  let rawSpeaker: string | null = null;
  const spans = block.querySelectorAll("span");
  for (const span of spans) {
    const t = span.textContent?.trim();
    if (t && t !== "arrow_downward" && !span.closest("button")) {
      rawSpeaker = t;
      break;
    }
  }

  // ── Caption text ───────────────────────────────────────────────────────────
  const divs = Array.from(block.querySelectorAll("div"));
  let text = "";

  for (let i = divs.length - 1; i >= 0; i--) {
    const div = divs[i]!;
    if (div.closest("button")) continue;
    const content = div.textContent?.trim() ?? "";

    if (!content) continue;
    if (
      content.includes("arrow_downward") ||
      content.includes("Jump to bottom")
    ) {
      continue;
    }

    if (rawSpeaker && div.querySelector("span")?.textContent?.trim() === rawSpeaker) {
      continue;
    }

    text = content;
    break;
  }

  if (!text) return null;

  const speaker = normalizeSpeaker(rawSpeaker, currentUserDisplayName);

  return { speaker, text };
}
