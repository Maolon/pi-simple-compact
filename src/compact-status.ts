import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Footer status key under which this extension publishes its transient compact indicator. */
export const COMPACT_STATUS_KEY = "pi-simple-compact";

/** Prefix used for automatic threshold/overflow compaction. */
export const AUTO_COMPACT_LABEL = "Auto compact";
/** Prefix used for manual /compact invocations. */
export const MANUAL_COMPACT_LABEL = "Manual compact";

export type CompactStatusReason = "manual" | "threshold" | "overflow";

/** Builds the in-progress label, e.g. `Auto compact (claude-sonnet-4)`. */
export function compactStatusLabel(reason: CompactStatusReason, summarizerDetail: string): string {
  const prefix = reason === "manual" ? MANUAL_COMPACT_LABEL : AUTO_COMPACT_LABEL;
  return `${prefix} (${summarizerDetail})`;
}

/**
 * Transient TUI activity indicator for one extension runtime.
 *
 * UI failures never change the compaction result or failure policy. The footer only
 * describes a running configured compact; every terminal outcome clears it.
 */
export function createCompactStatusTracker() {
  let active = false;

  const withTui = (context: ExtensionContext, run: (ui: ExtensionContext["ui"]) => void): void => {
    if (context.mode !== "tui") return;
    try {
      run(context.ui);
    } catch {
      // A status/notification failure must not cancel compaction or force fallback.
    }
  };

  const clear = (context: ExtensionContext): void => {
    if (!active) return;
    active = false;
    withTui(context, (ui) => ui.setStatus(COMPACT_STATUS_KEY, undefined));
  };

  return {
    /** Marks a configured custom compaction attempt as in progress. */
    begin(context: ExtensionContext, label: string): void {
      active = true;
      withTui(context, (ui) => ui.setStatus(COMPACT_STATUS_KEY, label));
    },
    /** A native pass-through must never leave an extension activity label behind. */
    clearOnNativePassThrough(context: ExtensionContext): void {
      clear(context);
    },
    /** Pi has persisted a compaction; the running label is no longer useful. */
    handleCompact(context: ExtensionContext): void {
      clear(context);
    },
    /** Handles `session_compact_failed` (covers cancellation and fail-closed aborts). */
    handleCompactFailed(context: ExtensionContext): void {
      clear(context);
    },
    /** Handles `session_shutdown` (quit, reload, or session replacement). */
    handleShutdown(context: ExtensionContext): void {
      clear(context);
    },
  };
}

export type CompactStatusTracker = ReturnType<typeof createCompactStatusTracker>;
