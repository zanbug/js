import { isBrowser, isNode } from '../env';
import { safe } from '../utils';

/**
 * Global error handlers.
 *
 * Browser: window.onerror and unhandledrejection. Node: uncaughtException and
 * unhandledRejection.
 *
 * The Node side deliberately does NOT swallow a fatal error. Keeping a process
 * alive after an uncaught exception leaves it in an undefined state; the SDK's
 * job is to report and then let the default behaviour happen. This is the same
 * lesson the PHP SDK carries: telemetry must never change how the host app
 * behaves.
 */

export interface GlobalHooks {
    capture: (error: unknown, extra: { handled: boolean; type?: string }) => void;
    /** Give the transport a moment to flush before the process dies. */
    flush: () => Promise<void>;
}

export function installGlobalHandlers(hooks: GlobalHooks): () => void {
    const undo: Array<() => void> = [];

    if (isBrowser) {
        const onError = (event: ErrorEvent) => {
            safe(() => {
                // event.error carries the real stack; message-only events (e.g.
                // cross-origin "Script error.") still produce a usable record.
                const err =
                    event.error ||
                    ({
                        name: 'Error',
                        message: event.message,
                        stack: undefined,
                    } as any);
                hooks.capture(err, { handled: false, type: 'onerror' });
            });
        };

        const onRejection = (event: PromiseRejectionEvent) => {
            safe(() => {
                const reason = (event as any).reason;
                hooks.capture(reason, { handled: false, type: 'unhandledrejection' });
            });
        };

        safe(() => window.addEventListener('error', onError, true));
        safe(() => window.addEventListener('unhandledrejection', onRejection as any, true));

        undo.push(() => {
            safe(() => window.removeEventListener('error', onError, true));
            safe(() => window.removeEventListener('unhandledrejection', onRejection as any, true));
        });
    }

    if (isNode) {
        const onUncaught = (err: unknown) => {
            hooks.capture(err, { handled: false, type: 'uncaughtException' });
            // Flush, then re-raise the default behaviour. If another listener is
            // registered, Node will not exit on its own — that is the host's
            // choice and we must not override it.
            safe(() => {
                void hooks.flush().then(() => {
                    if (process.listenerCount('uncaughtException') <= 1) {
                        process.exit(1);
                    }
                });
            });
        };

        const onUnhandled = (reason: unknown) => {
            hooks.capture(reason, { handled: false, type: 'unhandledRejection' });
        };

        safe(() => process.on('uncaughtException', onUncaught));
        safe(() => process.on('unhandledRejection', onUnhandled));
        // Best-effort flush of anything still queued at normal shutdown.
        safe(() => process.on('beforeExit', () => void hooks.flush()));

        undo.push(() => {
            safe(() => process.off('uncaughtException', onUncaught));
            safe(() => process.off('unhandledRejection', onUnhandled));
        });
    }

    return () => {
        for (const fn of undo) safe(fn);
    };
}
