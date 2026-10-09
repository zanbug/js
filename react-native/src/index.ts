/**
 * Zanbug SDK for React Native and Expo.
 *
 * A mobile app is not a small browser. Four things are genuinely different, and
 * each one is why this package exists rather than pointing customers at
 * @zanbug/react:
 *
 *  1. There is no DOM, so there is no DOM snapshot. The panel gets a REAL
 *     screenshot instead — see screenshot.ts for the privacy consequences.
 *  2. There are no Core Web Vitals. Start-up time, screen transitions and
 *     dropped frames are what a phone user actually feels — see perf.ts.
 *  3. The network goes away. An offline queue is not a nicety here; without it
 *     every crash in a lift or on a plane is lost — see storage.ts.
 *  4. React Native's own ErrorUtils owns the global handler. Installing over it
 *     without chaining would suppress the red box in development and, worse,
 *     whatever crash reporting the app already had.
 *
 * The one rule inherited from every other Zanbug SDK still holds: nothing here
 * may throw into the host app, and nothing optional may be imported statically
 * (Metro resolves requires at BUILD time — see native.ts).
 */

import { Zanbug, init as coreInit, capture, flush, setDeviceExtra } from '@zanbug/js';
import type { ZanbugOptions, EventStore, MobileScreenshot } from '@zanbug/js';

import { errorUtils, isExpo, mobileDeviceInfo, rn } from './native';
import { asyncStorageStore } from './storage';
import type { AsyncStorageLike } from './storage';
import { grabScreenshot } from './screenshot';
import type { CaptureFn, ScreenshotOptions } from './screenshot';
import {
    activeScreen,
    enableJank,
    installAppStart,
    installAppState,
    markAppReady,
    sampleJank,
    setScreen,
} from './perf';

// Injected by tsup (see tsup.config.ts) from this package's package.json.
declare const __ZANBUG_PKG__: string;
declare const __ZANBUG_PKG_VERSION__: string;
/** This adapter's own entry for the install ping's package list. */
function withOwnPackage(extra?: Record<string, string>): Record<string, string> {
    return { ...(extra || {}), [__ZANBUG_PKG__]: __ZANBUG_PKG_VERSION__ };
}

export * from '@zanbug/js';
export { setScreen, markAppReady, activeScreen, sampleJank } from './perf';
export { asyncStorageStore } from './storage';
export type { AsyncStorageLike } from './storage';
export type { CaptureFn, ScreenshotOptions } from './screenshot';
// <ZanbugMask> is NOT re-exported here: it imports react/react-native, and this
// entry has to stay importable from plain Node. It lives at
// `@zanbug/react-native/mask`.

export interface ReactNativeOptions extends ZanbugOptions {
    /**
     * Where the offline queue lives between launches. Pass AsyncStorage (or
     * MMKV, or anything with getItem/setItem/removeItem):
     *
     *   import AsyncStorage from '@react-native-async-storage/async-storage';
     *   initReactNative({ storage: AsyncStorage, ... });
     *
     * Without it the SDK still works — events just do not survive a restart,
     * which on mobile means losing most fatal crashes.
     */
    storage?: AsyncStorageLike | EventStore;

    /**
     * Screenshot capture. Nothing is captured unless you pass this, because
     * there is no way for the SDK to know your app has no password on screen:
     *
     *   import { captureScreen } from 'react-native-view-shot';
     *   initReactNative({ screenshot: { capture: captureScreen, masked: true } });
     */
    screenshot?: ScreenshotOptions | CaptureFn | false;

    /**
     * Sample frame timing around start-up and screen changes (default true).
     * Never a permanent loop — see perf.ts for why that matters for battery.
     */
    jank?: boolean;
}

let installed: Array<() => void> = [];

/**
 * Initialise Zanbug in a React Native or Expo app.
 *
 * Call once, at the very top of your entry file (index.js / App.tsx) — before
 * anything else can throw.
 */
export function initReactNative(options: ReactNativeOptions = {}) {
    const { storage, screenshot, jank, ...core } = options;

    const expo = isExpo();

    // OS, OS version and screen size on every event. The core cannot read them
    // itself — they live in the `react-native` module, which it must not import
    // (see native.ts). Set BEFORE init so the install ping already carries them.
    // Feature-detected: an older core simply will not have this function.
    if (typeof setDeviceExtra === 'function') {
        setDeviceExtra(mobileDeviceInfo());
    }

    const client = coreInit({
        framework: expo ? 'expo' : 'react-native',
        frameworkVersion: readRnVersion(),
        // A phone has no DOM to serialize; leaving this on would run the
        // snapshot code on every error for nothing.
        snapshot: false,
        // Web Vitals are browser-only. perf.ts reports the mobile equivalents.
        vitals: false,
        ...core,
        sdkPackages: withOwnPackage(core.sdkPackages),
    });

    teardown();

    // ---- offline queue --------------------------------------------------
    // Feature-detected, the same rule the PHP v1.5.2 outage taught us: a newer
    // adapter paired with an older core must degrade, never crash.
    if (storage) {
        const store: EventStore = isEventStore(storage)
            ? storage
            : asyncStorageStore(storage as AsyncStorageLike);

        const anyZanbug = Zanbug as unknown as { setEventStore?: (s: EventStore) => void };
        if (typeof anyZanbug.setEventStore === 'function') {
            anyZanbug.setEventStore(store);
        }
    }

    // ---- screenshots ------------------------------------------------------
    shotOptions =
        screenshot === false || screenshot == null
            ? undefined
            : typeof screenshot === 'function'
              ? { capture: screenshot }
              : screenshot;

    // Hand the capture to the core so EVERY error gets a picture — a plain
    // `Zanbug.capture(e)` from a try/catch, a 5xx reported by the network
    // integration, a fatal — not only the ones our own handlers see. Before
    // this, a handled error showed up in the panel without a screenshot and
    // nobody could tell which screen it came from. The core attaches the
    // shot AFTER the event is on disk, so a slow capture never costs the error.
    // Feature-detected: an older core simply keeps the old per-handler path.
    coreTakesScreenshots = false;
    if (shotOptions) {
        const anyZanbug = Zanbug as unknown as {
            setScreenshotProvider?: (p: (() => Promise<MobileScreenshot | null>) | null) => void;
        };
        if (typeof anyZanbug.setScreenshotProvider === 'function') {
            anyZanbug.setScreenshotProvider(() => grabScreenshot(shotOptions, activeScreen()));
            coreTakesScreenshots = true;
        }
    }

    // ---- performance ------------------------------------------------------
    enableJank(jank !== false);
    installAppStart();
    installed.push(installAppState());
    sampleJank();

    // ---- error handlers ---------------------------------------------------
    installed.push(installGlobalHandler());
    installed.push(installRejectionTracking());

    return client;
}

let shotOptions: ScreenshotOptions | undefined;
/** True when the core's screenshot provider is installed (core >= 1.4.0). */
let coreTakesScreenshots = false;

/** Tear down everything a previous init installed. */
function teardown(): void {
    for (const off of installed) {
        try {
            off();
        } catch {
            /* ignore */
        }
    }
    installed = [];
}

function isEventStore(v: unknown): v is EventStore {
    return Boolean(v && typeof (v as EventStore).load === 'function' && typeof (v as EventStore).save === 'function');
}

function readRnVersion(): string | undefined {
    try {
        // React Native exposes its version as a structured constant; reading
        // package.json is not possible inside a Metro bundle.
        const g: any = globalThis as any;
        const v = g.__REACT_NATIVE_VERSION__ || rn()?.Platform?.constants?.reactNativeVersion;
        if (v && typeof v === 'object') {
            const { major, minor, patch } = v as Record<string, number>;
            if (major != null) return `${major}.${minor ?? 0}.${patch ?? 0}`;
        }
        if (typeof v === 'string') return v;
    } catch {
        /* ignore */
    }
    return undefined;
}

/**
 * Report an error together with a screenshot of the screen it happened on.
 *
 * Use this in a `catch` when the visual state matters ("the list rendered
 * empty"). The screenshot is awaited, so this returns a promise — the plain
 * `capture()` from @zanbug/js is still synchronous and still available.
 */
export async function captureWithScreenshot(
    error: unknown,
    extra: Record<string, unknown> = {},
): Promise<void> {
    const screen = activeScreen();
    const shot = await grabScreenshot(shotOptions, screen);
    const callerContext = (extra.context as Record<string, unknown> | undefined) || {};

    capture(error, {
        handled: true,
        type: 'react-native',
        ...extra,
        // Same `context.mobile` shape the crash path writes, so the panel does
        // not have to special-case handled errors to find the screen name.
        context: {
            ...callerContext,
            mobile: { ...mobileDeviceInfo(), screen, fatal: false },
        },
        screenshot: shot,
    });
}

/**
 * Chain onto React Native's global handler instead of replacing it.
 *
 * ErrorUtils already has a handler installed — in development it draws the red
 * box, and in production the app may have its own reporter on it. Overwriting
 * it silently would take both away, which is the mobile shape of the mistake
 * that broke a customer's PHP site.
 */
function installGlobalHandler(): () => void {
    const eu = errorUtils();
    if (!eu || typeof eu.setGlobalHandler !== 'function') return () => {};

    const previous = typeof eu.getGlobalHandler === 'function' ? eu.getGlobalHandler() : undefined;

    const handler = (error: unknown, isFatal?: boolean) => {
        // Report first: on a fatal error the previous handler may end the
        // process, and anything after it never runs.
        try {
            void reportCrash(error, Boolean(isFatal));
        } catch {
            /* never let reporting swallow the app's own handler */
        }

        try {
            previous?.(error, isFatal);
        } catch {
            /* the previous handler's problem, not ours */
        }
    };

    eu.setGlobalHandler(handler);

    return () => {
        try {
            if (previous) eu.setGlobalHandler!(previous);
        } catch {
            /* ignore */
        }
    };
}

/**
 * A fatal error is a race: the app may be gone before the request completes.
 *
 * The event is therefore queued FIRST — enqueue() writes it to disk before
 * anything else — and the screenshot is taken afterwards by the core's
 * provider, best effort and bounded. If the process dies in between, the next
 * launch still delivers the crash, just without the picture. With an old core
 * (no setScreenshotProvider) the adapter grabs the shot itself for non-fatals
 * and skips it for fatals, as it always did.
 */
async function reportCrash(error: unknown, isFatal: boolean): Promise<void> {
    const screen = activeScreen();
    // With a core that has setScreenshotProvider the picture is taken by the
    // core, after the event is queued — for fatals too, best effort, bounded.
    // Only an old core still needs the adapter to grab it here first.
    const shot: MobileScreenshot | null =
        coreTakesScreenshots || isFatal ? null : await grabScreenshot(shotOptions, screen);

    capture(error, {
        handled: false,
        type: isFatal ? 'react-native.fatal' : 'react-native.error',
        context: {
            mobile: {
                ...mobileDeviceInfo(),
                screen,
                fatal: isFatal,
            },
        },
        screenshot: shot,
    });

    // Give delivery a chance before the runtime tears down. It may not finish;
    // the offline queue is the guarantee, this is the fast path.
    if (isFatal) {
        try {
            await flush();
        } catch {
            /* ignore */
        }
    }
}

/**
 * Unhandled promise rejections.
 *
 * React Native has no `window.onunhandledrejection`. Hermes exposes a tracker
 * hook instead; on JSC the `promise` polyfill's rejection-tracking module does
 * the same job, but requiring it statically would be a Metro dependency we
 * cannot guarantee — so Hermes (the default engine since RN 0.70) is handled
 * and everything else degrades to "reported when it reaches ErrorUtils".
 */
function installRejectionTracking(): () => void {
    try {
        const hermes: any = (globalThis as any).HermesInternal;
        if (!hermes || typeof hermes.enablePromiseRejectionTracker !== 'function') {
            return () => {};
        }

        hermes.enablePromiseRejectionTracker({
            allRejections: true,
            onUnhandled: (id: number, rejection: unknown) => {
                try {
                    capture(rejection instanceof Error ? rejection : new Error(String(rejection)), {
                        handled: false,
                        type: 'react-native.unhandledrejection',
                        context: { mobile: { ...mobileDeviceInfo(), screen: activeScreen() } },
                    });
                } catch {
                    /* ignore */
                }
            },
            onHandled: () => {
                /* a rejection handled late is not a defect worth an alert */
            },
        });

        // Hermes has no "disable" counterpart, so re-init leaves the tracker in
        // place. That is harmless: capture() is idempotent per Error object.
        return () => {};
    } catch {
        return () => {};
    }
}

