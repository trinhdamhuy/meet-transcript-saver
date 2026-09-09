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
 *
 * HTML structure (observed September 2026, for reference only):
 *
 *   <div role="region" aria-label="Captions">   ← STABLE (ARIA)
 *     <div>                                      ← caption block (direct child)
 *       <div>
 *         <span>Speaker Name</span>              ← first non-empty <span> in block
 *       </div>
 *       <div>Caption text goes here...</div>     ← last non-empty <div> in block
 *     </div>
 *   </div>
 */

// ─── Stable root selector ─────────────────────────────────────────────────────

/**
 * The only CSS selector we hardcode. ARIA attributes are stable across
 * Google Meet UI rewrites.
 */
export const CAPTIONS_REGION_SELECTOR =
  'div[role="region"][aria-label="Captions"]';

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
 * A caption block is defined as a direct child <div> of the region that
 * contains non-empty text content.
 * Filters out UI controls (e.g., "Jump to bottom" button, icon buttons).
 */
export function getCaptionBlocks(region: Element): Element[] {
  return Array.from(region.children).filter(
    (el) => el.tagName === "DIV" && el.textContent?.trim(),
  );
  return Array.from(region.children).filter((el) => {
    if (el.tagName !== "DIV" || !el.textContent?.trim()) return false;
    // Skip if it contains button/interactive UI controls like "Jump to bottom"
    if (el.querySelector("button") || el.matches("button")) return false;
    if (
      el.textContent.includes("Jump to bottom") ||
      el.textContent.includes("arrow_downward")
    )
      return false;
    return true;
  });
}

// ─── Data extraction from a single block ─────────────────────────────────────

/**
 * Extracts { speaker, text } from a caption block using structural heuristics.
 *
 * Strategy:
 * - Speaker: the first <span> anywhere in the block that contains non-empty text.
 *   In Meet's DOM the speaker name is always in a <span> while caption text is
 *   in a <div>. This distinction is structural, not class-based.
 * - Text: the last non-empty <div> (direct or nested) inside the block that is
 *   NOT an ancestor of the speaker <span>. This is the live caption text div.
 *
 * Returns null when the block yields no usable text (transient / empty state).
 */
export function extractBlockData(
  block: Element,
): { speaker: string | null; text: string } | null {
  // If the block is a button or contains a scroll-to-bottom button, ignore it completely
  if (block.matches("button") || block.querySelector("button")) return null;
  if (
    block.textContent?.includes("Jump to bottom") ||
    block.textContent?.includes("arrow_downward")
  )
    return null;

  // ── Speaker ────────────────────────────────────────────────────────────────
  // Find the first <span> with text — this is the speaker name.
  // Ignore material icons or UI buttons
  let speaker: string | null = null;
  const spans = block.querySelectorAll("span");
  for (const span of spans) {
    const t = span.textContent?.trim();
    if (t && t !== "arrow_downward" && !span.closest("button")) {
      speaker = t;
      break;
    }
  }

  // ── Caption text ───────────────────────────────────────────────────────────
  // Find all <div> elements inside the block, then pick the last one that
  // has non-empty text and is NOT an ancestor of the speaker <span>.
  const divs = Array.from(block.querySelectorAll("div"));
  let text = "";

  // Walk in reverse to find the deepest/last meaningful text container.
  for (let i = divs.length - 1; i >= 0; i--) {
    const div = divs[i]!;
    if (div.closest("button")) continue;
    const content = div.textContent?.trim() ?? "";

    if (!content) continue;
    if (
      content.includes("arrow_downward") ||
      content.includes("Jump to bottom")
    )
      continue;

    // Skip if this div contains the speaker span (it's the speaker container).
    if (speaker && div.querySelector("span")?.textContent?.trim() === speaker) {
      continue;
    }

    text = content;
    break;
  }

  if (!text) return null;

  return { speaker, text };
}
