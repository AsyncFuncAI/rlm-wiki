/**
 * Idempotent signal cleanup handler.
 * Guarantees resource teardown on SIGINT (Ctrl+C) and SIGTERM with correct exit codes.
 */

type CleanupFn = () => void | Promise<void>;

interface ProcessLike {
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  exit(code: number): void;
}

/**
 * Register signal handlers for clean shutdown.
 *
 * @param cleanupFn - Async or sync cleanup function (called once)
 * @param proc - Process object (for testability)
 * @returns unregister - Call to remove the signal handlers
 */
export function registerSignalCleanup(cleanupFn: CleanupFn, proc: ProcessLike = process as unknown as ProcessLike): () => void {
    let didCleanup = false;

    const cleanup = async (): Promise<void> => {
        if (didCleanup) return;
        didCleanup = true;
        try {
            await cleanupFn();
        } catch {
            // Ignore cleanup errors — we're shutting down
        }
    };

    const forwardSignal = async (signal: string): Promise<void> => {
        proc.removeListener("SIGINT", onSigint);
        proc.removeListener("SIGTERM", onSigterm);
        await cleanup();
        // Exit with correct code: 128 + signal number (SIGINT=2→130, SIGTERM=15→143)
        proc.exit(signal === "SIGINT" ? 130 : 143);
    };

    const onSigint = (): void => { forwardSignal("SIGINT"); };
    const onSigterm = (): void => { forwardSignal("SIGTERM"); };

    proc.once("exit", () => {
        // Synchronous — best-effort cleanup on normal exit
        if (!didCleanup) {
            didCleanup = true;
            try { cleanupFn(); } catch { }
        }
    });
    proc.on("SIGINT", onSigint);
    proc.on("SIGTERM", onSigterm);

    // Return unregister function
    return () => {
        proc.removeListener("SIGINT", onSigint);
        proc.removeListener("SIGTERM", onSigterm);
    };
}

