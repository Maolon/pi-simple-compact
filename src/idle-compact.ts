import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { IdleCompactOptions } from "./config.ts";

export interface IdleCompactSchedulerOptions {
  /** Resolves the idle policy for the session at the moment it became idle; undefined disables. */
  resolve(context: ExtensionContext): Promise<IdleCompactOptions | undefined>;
  /** Reports a bounded, transcript-free diagnostic. */
  report(context: ExtensionContext, message: string, level: "info" | "warning"): void;
}

/**
 * Compacts an idle session once its provider prompt cache has gone cold.
 *
 * The only trigger is Pi's own `agent_end`: a timer starts when a run ends and any new
 * activity cancels it. When it fires, compaction goes through `ctx.compact()`, i.e. the same
 * `session_before_compact` path and profile resolution as `/compact`. Nothing here changes
 * Pi's threshold or overflow compaction.
 */
export function createIdleCompactScheduler(options: IdleCompactSchedulerOptions) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let pendingIdleCompact = false;

  const cancel = (): void => {
    generation++;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const fire = (context: ExtensionContext, policy: IdleCompactOptions): void => {
    timer = undefined;
    try {
      if (!context.isIdle() || context.hasPendingMessages()) return;
      const usage = context.getContextUsage();
      if (!usage || usage.tokens === null || usage.tokens < policy.minContextTokens) return;
      pendingIdleCompact = true;
      options.report(
        context,
        `Idle for ${policy.afterIdleMinutes} min; the prompt cache is likely cold. Compacting ${usage.tokens} context tokens before the next turn.`,
        "info",
      );
      context.compact({
        onComplete: () => {
          pendingIdleCompact = false;
        },
        onError: (error) => {
          pendingIdleCompact = false;
          // A fail-closed cancellation was already reported by the compact hook itself.
          if (/cancel/i.test(error.message)) return;
          options.report(context, `Idle compaction failed: ${error.message.slice(0, 300)}`, "warning");
        },
      });
    } catch {
      // A stale context (reload, session switch) or a busy session simply skips this idle period.
      pendingIdleCompact = false;
    }
  };

  return {
    /** Starts the idle timer after a run ends. Any earlier timer is replaced. */
    async schedule(context: ExtensionContext): Promise<void> {
      cancel();
      const scheduled = generation;
      let policy: IdleCompactOptions | undefined;
      try {
        // Print and JSON runs exit after their prompt; there is no idle period to use.
        if (context.mode === "print" || context.mode === "json") return;
        policy = await options.resolve(context);
      } catch {
        return;
      }
      if (!policy || scheduled !== generation) return;
      timer = setTimeout(() => fire(context, policy), policy.afterIdleMinutes * 60_000);
      // Never keep a finished Pi process alive just for this timer.
      (timer as { unref?: () => void }).unref?.();
    },
    /** New activity, a model change, a compaction, or shutdown ends the idle period. */
    cancel,
    /** True exactly once for the compaction this scheduler started. */
    consumeIdleTrigger(): boolean {
      const value = pendingIdleCompact;
      pendingIdleCompact = false;
      return value;
    },
  };
}

export type IdleCompactScheduler = ReturnType<typeof createIdleCompactScheduler>;
