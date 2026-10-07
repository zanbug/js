import { recordMetric, addBreadcrumb } from '@zanbug/js';
import { rn } from './native';

/**
 * Mobile performance.
 *
 * Core Web Vitals do not translate: there is no largest contentful paint on a
 * phone and no layout shift to accumulate. What a user actually notices is
 *   - how long the app takes to become usable (APP_START),
 *   - how long moving to another screen takes (SCREEN_LOAD),
 *   - whether the UI stutters while they interact (JANK).
 *
 * All three go through the same ingest endpoint and the same table as the web
 * metrics — the shape is identical (name + value + screen + session), only the
 * names differ, so the panel renders them with the existing cards.
 */

/**
 * Module evaluation time — the earliest moment this SDK can observe.
 *
 * It is NOT process start: the native side has already run, and on a cold start
 * that is a real part of the wait. Treating it as process start would flatter
 * the number, so the metric is documented as "JS start → usable", and an app
 * that has a native start timestamp can pass it to `markAppReady({ startedAt })`.
 */
const jsStart = Date.now();

let appReadyReported = false;

/**
 * Report the app as usable. Called automatically after the first interaction
 * batch drains; call it yourself the moment your first real screen has data,
 * which is what the user means by "the app opened".
 */
export function markAppReady(options: { startedAt?: number; screen?: string } = {}): void {
    if (appReadyReported) return;
    appReadyReported = true;

    const from = typeof options.startedAt === 'number' ? options.startedAt : jsStart;
    const ms = Date.now() - from;

    // A wall-clock jump (device asleep during launch, clock resync) can produce
    // an absurd figure that would poison the p75 for everyone.
    if (!isFinite(ms) || ms <= 0 || ms > 120_000) return;

    recordMetric({ name: 'APP_START', value: ms, url: options.screen });
}

/** Wire up the automatic app-ready report. */
export function installAppStart(): void {
    try {
        const im = rn()?.InteractionManager;
        if (im && typeof im.runAfterInteractions === 'function') {
            // Fires once the first batch of animations/interactions has drained,
            // which is as close to "the first screen settled" as RN exposes
            // without the app telling us.
            im.runAfterInteractions(() => markAppReady());
            return;
        }
    } catch {
        /* fall through */
    }

    // No InteractionManager (web preview, tests): a timer is still better than
    // never reporting.
    const t: any = setTimeout(() => markAppReady(), 3000);
    if (t && typeof t.unref === 'function') t.unref();
}

let currentScreen: string | undefined;
let screenEnteredAt = 0;

/** The screen the user is on. Attached to events and to every metric. */
export function activeScreen(): string | undefined {
    return currentScreen;
}

/**
 * Tell Zanbug the user moved to another screen.
 *
 * Call from your navigator's change handler (React Navigation's `onStateChange`,
 * Expo Router's `usePathname`). This is what makes a crash report say "it broke
 * on Checkout" instead of naming a minified component.
 */
export function setScreen(name: string): void {
    try {
        const now = Date.now();

        // Time spent getting HERE is the previous transition's cost.
        if (currentScreen && screenEnteredAt) {
            const ms = now - screenEnteredAt;
            if (isFinite(ms) && ms > 0 && ms < 60_000) {
                recordMetric({ name: 'SCREEN_LOAD', value: ms, url: name });
            }
        }

        currentScreen = name;
        screenEnteredAt = now;

        addBreadcrumb({ type: 'navigation', level: 'info', message: `screen: ${name}` });

        // Navigation is one of the two moments jank actually matters.
        sampleJank(JANK_WINDOW_MS);
    } catch {
        /* navigation reporting must never break navigation */
    }
}

const JANK_WINDOW_MS = 8000;
/** Anything over this is a visible stutter; below it nobody notices. */
const JANK_FLOOR_MS = 100;

let jankEnabled = false;
let jankUntil = 0;
let jankRunning = false;
let lastFrame = 0;
let worstInWindow = 0;

export function enableJank(on: boolean): void {
    jankEnabled = on;
}

/**
 * Watch frame timing for a short window.
 *
 * Deliberately NOT a permanent loop. A requestAnimationFrame chain that never
 * stops keeps the JS thread scheduled on every frame for the life of the app,
 * and a monitoring SDK that costs the user battery has made the app worse. Jank
 * matters at exactly two moments — start-up and screen transitions — so it is
 * sampled there and nowhere else.
 */
export function sampleJank(durationMs: number = JANK_WINDOW_MS): void {
    if (!jankEnabled) return;

    const raf: any = (globalThis as any).requestAnimationFrame;
    if (typeof raf !== 'function') return;

    jankUntil = Date.now() + durationMs;
    if (jankRunning) return; // extend the existing window instead of stacking loops

    jankRunning = true;
    lastFrame = 0;
    worstInWindow = 0;

    const tick = () => {
        try {
            const now = Date.now();
            if (lastFrame) {
                const delta = now - lastFrame;
                if (delta >= JANK_FLOOR_MS && delta > worstInWindow && delta < 10_000) {
                    worstInWindow = delta;
                }
            }
            lastFrame = now;

            if (now < jankUntil) {
                raf(tick);
                return;
            }

            jankRunning = false;
            // One sample per window, the worst one. Reporting every dropped
            // frame would flood the endpoint during a single bad transition.
            if (worstInWindow >= JANK_FLOOR_MS) {
                recordMetric({ name: 'JANK', value: worstInWindow, url: currentScreen });
            }
        } catch {
            jankRunning = false;
        }
    };

    raf(tick);
}

/**
 * Foreground/background transitions as breadcrumbs.
 *
 * "It crashes when I come back to the app" is a real and common report, and
 * without this the trail simply stops before the crash.
 */
export function installAppState(): () => void {
    try {
        const appState = rn()?.AppState;
        if (!appState || typeof appState.addEventListener !== 'function') return () => {};

        const sub: any = appState.addEventListener('change', (state: string) => {
            addBreadcrumb({ type: 'navigation', level: 'info', message: `app ${state}` });
            // Coming back from the background re-renders and re-fetches — the
            // other moment where a stutter is worth measuring.
            if (state === 'active') sampleJank(JANK_WINDOW_MS);
        });

        return () => {
            try {
                sub?.remove?.();
            } catch {
                /* ignore */
            }
        };
    } catch {
        return () => {};
    }
}
