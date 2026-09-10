/**
 * lib/transcript/parser.ts
 *
 * Wraps a MutationObserver to track Google Meet captions in real time.
 *
 * Key behaviours
 * ──────────────
 * • Maintains a per-speaker Map of in-progress CaptionEntry objects.
 * • Live typing → updates in-progress entry only; does NOT emit yet.
 * • Block removed from DOM → finalizes + emits that speaker's entry.
 * • Debounce: any entry stable for >= DEBOUNCE_MS is finalized and emitted
 *   even if the block hasn't been removed (handles rapid speaker changes).
 * • Deduplication: never emits two consecutive entries with identical
 *   (speaker, text) pairs.
 * • Retry: if the captions region isn't present on `start()`, retries every
 *   RETRY_INTERVAL_MS for up to MAX_RETRY_MS before giving up.
 * • Sequence numbers are monotonically increasing from 0 per parser instance.
 * • Errors are logged; no exceptions are re-thrown.
 */

import {
  findCaptionsRegion,
  getCaptionBlocks,
  extractBlockData,
} from "@/lib/transcript/selectors";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A caption as it is building up (internal / in-progress state). */
export type CaptionEntry = {
  speaker: string | null;
  text: string;
  /** ISO timestamp recorded when this entry was first seen. */
  startedAt: string;
};

/** A finalized caption emitted to the consumer. */
export type ParsedCaption = {
  sequence: number;
  speaker: string | null;
  text: string;
  /** ISO timestamp recorded when this entry was first seen. */
  startedAt: string;
};

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Milliseconds a caption must be stable before it is auto-finalized. */
const DEBOUNCE_MS = 2_500;

/** How often to retry finding the captions region. */
const RETRY_INTERVAL_MS = 2_000;

/** Give up looking for the captions region after this many milliseconds. */
const MAX_RETRY_MS = 60_000;

// ---------------------------------------------------------------------------
// Internal extended entry type (not exported)
// ---------------------------------------------------------------------------

type InProgressEntry = CaptionEntry & {
  debounceHandle: ReturnType<typeof setTimeout> | null;
};

// ---------------------------------------------------------------------------
// CaptionParser
// ---------------------------------------------------------------------------

export class CaptionParser {
  // ── Configuration ────────────────────────────────────────────────────────

  private readonly onCaption: (entry: ParsedCaption) => void;

  // ── Runtime state ────────────────────────────────────────────────────────

  /** True while the observer is connected. */
  private active = false;

  /** The MutationObserver watching the captions region. */
  private observer: MutationObserver | null = null;

  /** Retry interval handle while looking for the captions region. */
  private retryHandle: ReturnType<typeof setInterval> | null = null;

  /** Elapsed ms spent retrying. */
  private retryElapsed = 0;

  // ── Caption state ────────────────────────────────────────────────────────

  /**
   * In-progress entries keyed by speaker name (or '__unknown__' when the
   * name element is absent in the DOM).
   */
  private inProgress = new Map<string, InProgressEntry>();

  /** Monotonically increasing sequence counter. */
  private sequence = 0;

  /** The last emitted (speaker, text) pair for deduplication. */
  private lastEmitted: { speaker: string | null; text: string } | null = null;

  /** Current authenticated user's display name to replace generic 'You' labels */
  private currentUserDisplayName: string | null = null;

  /** Known recent texts to prevent duplicate emissions upon resuming */
  private recentHistory = new Set<string>();

  // ── Constructor ──────────────────────────────────────────────────────────

  constructor(
    onCaption: (entry: ParsedCaption) => void,
    currentUserDisplayName?: string | null,
  ) {
    this.onCaption = onCaption;
    this.currentUserDisplayName = currentUserDisplayName ?? null;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  setUserDisplayName(name: string | null): void {
    this.currentUserDisplayName = name;
  }

  /**
   * Start observing captions.
   * If initialSequence is provided (when resuming an existing meeting), sequences
   * will continue from that number instead of 0.
   */
  start(options?: {
    initialSequence?: number;
    seedRecentTexts?: string[];
    currentUserDisplayName?: string | null;
  }): void {
    if (this.active) return;

    if (options?.currentUserDisplayName !== undefined) {
      this.currentUserDisplayName = options.currentUserDisplayName;
    }

    this.active = true;
    this.sequence = options?.initialSequence ?? 0;
    this.lastEmitted = null;
    this.inProgress.clear();
    this.recentHistory.clear();

    if (options?.seedRecentTexts) {
      for (const text of options.seedRecentTexts) {
        if (text?.trim()) {
          this.recentHistory.add(text.trim());
        }
      }
    }

    this._tryAttach();
  }

  /** Stop observing and reset all internal state. */
  stop(): void {
    if (!this.active) return;
    this.active = false;

    this._clearRetry();
    this._disconnectObserver();

    // Cancel all pending debounce timers without emitting.
    for (const entry of this.inProgress.values()) {
      if (entry.debounceHandle !== null) clearTimeout(entry.debounceHandle);
    }
    this.inProgress.clear();
    this.lastEmitted = null;
    this.recentHistory.clear();
  }

  getSequence(): number {
    return this.sequence;
  }

  isActive(): boolean {
    return this.active;
  }

  // ── Retry logic ──────────────────────────────────────────────────────────

  private _tryAttach(): void {
    const region = findCaptionsRegion();
    if (region) {
      this._attachObserver(region);
      return;
    }

    // Start retry loop.
    this.retryElapsed = 0;
    this.retryHandle = setInterval(() => {
      if (!this.active) {
        this._clearRetry();
        return;
      }

      this.retryElapsed += RETRY_INTERVAL_MS;

      const r = findCaptionsRegion();
      if (r) {
        this._clearRetry();
        this._attachObserver(r);
        return;
      }

      if (this.retryElapsed >= MAX_RETRY_MS) {
        this._clearRetry();
        console.warn(
          "[CaptionParser] Captions region not found after 60 s; giving up.",
        );
        this.active = false;
      }
    }, RETRY_INTERVAL_MS);
  }

  private _clearRetry(): void {
    if (this.retryHandle !== null) {
      clearInterval(this.retryHandle);
      this.retryHandle = null;
    }
  }

  // ── Observer attachment ───────────────────────────────────────────────────

  private _attachObserver(root: Element): void {
    try {
      this.observer = new MutationObserver((mutations) =>
        this._handleMutations(mutations),
      );
      this.observer.observe(root, {
        childList: true, // detect caption blocks being added / removed
        subtree: true, // catch changes anywhere inside the region
        characterData: true, // detect text node changes (live typing)
      });

      // Snapshot any blocks already present when we attach.
      this._snapshotCurrentBlocks(root);
    } catch (err) {
      console.error("[CaptionParser] Failed to attach MutationObserver:", err);
    }
  }

  private _disconnectObserver(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  // ── Initial snapshot ─────────────────────────────────────────────────────

  /**
   * When we first attach to a region that already has caption blocks, we
   * snapshot them so that removals are detected correctly later.
   */
  private _snapshotCurrentBlocks(root: Element): void {
    const blocks = getCaptionBlocks(root);
    for (const block of blocks) {
      const data = extractBlockData(block, this.currentUserDisplayName);
      if (!data) continue;
      this._upsertInProgress(data.speaker, data.text);
    }
  }

  // ── Mutation handling ─────────────────────────────────────────────────────

  private _handleMutations(mutations: MutationRecord[]): void {
    try {
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          // Removed nodes: finalize any entries whose blocks left the DOM.
          for (const removed of mutation.removedNodes) {
            if (!(removed instanceof Element)) continue;
            this._handleRemovedNode(removed);
          }

          // Added nodes: snapshot new caption blocks.
          for (const added of mutation.addedNodes) {
            if (!(added instanceof Element)) continue;
            this._handleAddedNode(added);
          }
        } else if (mutation.type === "characterData") {
          // Text changed inside a caption block — walk up to find the block.
          const block = this._closestBlock(mutation.target);
          if (!block) continue;
          const data = extractBlockData(block, this.currentUserDisplayName);
          if (!data) continue;
          this._upsertInProgress(data.speaker, data.text);
        }
      }
    } catch (err) {
      console.error("[CaptionParser] Error handling mutations:", err);
    }
  }

  private _handleRemovedNode(node: Element): void {
    // Try to extract data directly from removed node (it's still in memory)
    const data = extractBlockData(node, this.currentUserDisplayName);
    if (data) {
      this._finalizeByRemovedBlock(node);
      return;
    }
    // The removed node might be a container — check its children
    const children = Array.from(node.querySelectorAll("div"));
    for (const child of children) {
      if (extractBlockData(child, this.currentUserDisplayName)) {
        this._finalizeByRemovedBlock(child);
      }
    }
  }

  private _handleAddedNode(node: Element): void {
    const data = extractBlockData(node, this.currentUserDisplayName);
    if (data) {
      this._upsertInProgress(data.speaker, data.text);
      return;
    }
    // Check children in case a container was added
    const children = Array.from(node.querySelectorAll("div"));
    for (const child of children) {
      const childData = extractBlockData(child, this.currentUserDisplayName);
      if (childData) this._upsertInProgress(childData.speaker, childData.text);
    }
  }

  // ── In-progress map helpers ───────────────────────────────────────────────

  private _speakerKey(speaker: string | null): string {
    return speaker ?? "__unknown__";
  }

  /**
   * Create or update an in-progress entry.  Resets the debounce timer each
   * time the text changes (live typing scenario).
   */
  private _upsertInProgress(speaker: string | null, text: string): void {
    const key = this._speakerKey(speaker);
    const existing = this.inProgress.get(key);

    if (existing) {
      existing.text = text;
      existing.speaker = speaker;

      // Reset debounce timer so we don't prematurely finalize mid-speech.
      if (existing.debounceHandle !== null)
        clearTimeout(existing.debounceHandle);
      existing.debounceHandle = setTimeout(
        () => this._finalizeByKey(key),
        DEBOUNCE_MS,
      );
    } else {
      const handle = setTimeout(() => this._finalizeByKey(key), DEBOUNCE_MS);
      this.inProgress.set(key, {
        speaker,
        text,
        startedAt: new Date().toISOString(),
        debounceHandle: handle,
      });
    }
  }

  /**
   * Finalize and emit the in-progress entry for a given speaker key.
   * Called either by the debounce timer or when the block is removed from DOM.
   */
  private _finalizeByKey(key: string): void {
    const entry = this.inProgress.get(key);
    if (!entry) return;

    if (entry.debounceHandle !== null) {
      clearTimeout(entry.debounceHandle);
      entry.debounceHandle = null;
    }

    this.inProgress.delete(key);
    this._emit(entry.speaker, entry.text, entry.startedAt);
  }

  /**
   * When a block is removed from the DOM we no longer have access to its
   * text from the DOM, so we finalize whatever we have stored in inProgress
   * for the speaker derived from the (still in-memory) element.
   */
  private _finalizeByRemovedBlock(block: Element): void {
    // The element is removed from the document but its in-memory tree is
    // still accessible. Use extractBlockData's structural heuristic.
    const data = extractBlockData(block, this.currentUserDisplayName);
    const speaker = data?.speaker ?? null;
    const key = this._speakerKey(speaker);

    if (this.inProgress.has(key)) {
      this._finalizeByKey(key);
    }
  }

  // ── Emit ─────────────────────────────────────────────────────────────────

  private _emit(speaker: string | null, text: string, startedAt: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Deduplication: skip if identical to last emission.
    if (
      this.lastEmitted &&
      this.lastEmitted.speaker === speaker &&
      this.lastEmitted.text === text
    ) {
      return;
    }

    // Deduplication across resume: skip if already in seeded recent history
    if (this.recentHistory.has(trimmed)) {
      return;
    }

    const parsed: ParsedCaption = {
      sequence: this.sequence++,
      speaker,
      text,
      startedAt,
    };

    this.lastEmitted = { speaker, text };
    this.recentHistory.add(trimmed);

    try {
      this.onCaption(parsed);
    } catch (err) {
      console.error("[CaptionParser] onCaption callback threw:", err);
    }
  }

  // ── Utility ──────────────────────────────────────────────────────────────

  /**
   * Walk up the DOM from a Node to find the nearest ancestor (or self) that
   * is a direct child of the captions region (i.e. a caption block).
   * Uses structural position rather than class names.
   */
  private _closestBlock(node: Node): Element | null {
    const region = findCaptionsRegion();
    if (!region) return null;

    let current: Node | null = node;
    while (current && current !== region) {
      if (current instanceof Element && current.parentElement === region) {
        return current;
      }
      current = current.parentNode;
    }
    return null;
  }
}
