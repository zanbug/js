import type { ConsoleOptions, Level } from '../types';
import { safe, truncate } from '../utils';

/**
 * console.* interception.
 *
 * Most real-world failures never reach window.onerror: the app catches the
 * error, logs it with console.error, and shows a generic "something went
 * wrong". Those are exactly the ones a developer wants reported, so
 * console.error becomes a first-class event, not just a breadcrumb.
 *
 * The original console methods are always called — the developer's own logging
 * must behave identically with the SDK installed.
 */

export interface ConsoleHooks {
    breadcrumb: (level: Level, message: string, args: unknown[]) => void;
    capture: (level: Level, message: string, args: unknown[]) => void;
}

const LEVEL_MAP: Record<string, Level> = {
    log: 'info',
    info: 'info',
    debug: 'debug',
    warn: 'warning',
    error: 'error',
};

/** Was an actual Error passed to console.error, or just text? */
function hasErrorArg(args: unknown[]): boolean {
    for (const a of args) {
        if (a instanceof Error) return true;
    }
    return false;
}

export function installConsole(opts: Required<ConsoleOptions>, hooks: ConsoleHooks): () => void {
    if (typeof console === 'undefined') return () => {};

    const originals: Record<string, any> = {};
    // Re-entrancy guard: if a hook itself logs (or the transport warns in debug
    // mode), we must not recurse into our own interceptor.
    let inside = false;

    for (const method of opts.levels) {
        const original = (console as any)[method];
        if (typeof original !== 'function') continue;
        originals[method] = original;

        (console as any)[method] = function (...args: unknown[]) {
            try {
                if (!inside) {
                    inside = true;
                    const level = LEVEL_MAP[method] || 'info';
                    const message = args
                        .map((a) => (typeof a === 'string' ? a : truncate(a, 200)))
                        .join(' ');

                    hooks.breadcrumb(level, truncate(message, 500), args);

                    if (
                        (method === 'error' || method === 'warn') &&
                        opts.captureAsEvent.indexOf(method as 'error' | 'warn') !== -1
                    ) {
                        // When the logged value is a real Error, some other
                        // handler is usually about to report the same throw with
                        // far better context — React logs a render crash to the
                        // console just before componentDidCatch runs, and the
                        // boundary knows the component stack while we only know
                        // "console".
                        //
                        // Yield a tick so the richer reporter claims it first;
                        // the client's identity-based dedupe then drops this
                        // one. If nobody else claims it, this still fires and
                        // the error is reported — only ~50ms later.
                        if (hasErrorArg(args)) {
                            const deferred = () => safe(() => hooks.capture(level, message, args));
                            safe(() => {
                                const t: any = setTimeout(deferred, 50);
                                // Never hold a Node process open for this.
                                if (t && typeof t.unref === 'function') t.unref();
                            });
                        } else {
                            hooks.capture(level, message, args);
                        }
                    }
                    inside = false;
                }
            } catch {
                inside = false;
            }

            // Always pass through to the real console.
            return safe(() => original.apply(console, args));
        };
    }

    return () => {
        for (const m in originals) {
            safe(() => {
                (console as any)[m] = originals[m];
            });
        }
    };
}
