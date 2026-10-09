import type { MobileScreenshot } from '@zanbug/js';
import { withMasksCovered } from './mask';

/**
 * Real screenshots at error time.
 *
 * On the web the SDK serializes the DOM and the panel re-renders it in an
 * iframe, which keeps text selectable and inputs maskable after the fact. A
 * phone has no DOM, so the only faithful record of what the user saw is an
 * image — and that moves the whole privacy burden onto the capture itself.
 * Once the pixels exist, nothing downstream can tell a password field from any
 * other grey rectangle.
 *
 * Two rules follow. The app supplies the capture function (usually
 * `captureScreen` from react-native-view-shot) — there is no default, because
 * silently photographing a banking app is not a reasonable default. And
 * anything sensitive is wrapped in <ZanbugMask>, which this module covers over
 * before the shutter opens; see mask.ts for why that is the only way on RN and
 * what the earlier, non-working advice was.
 */

/** What react-native-view-shot's `captureScreen` looks like to us. */
export type CaptureFn = (options?: Record<string, unknown>) => Promise<string>;

export interface ScreenshotOptions {
    /**
     * The capture function. Without it no screenshot is ever taken — there is
     * no safe default, because taking an unmasked picture of a banking app is
     * worse than having no picture at all.
     *
     *   import { captureScreen } from 'react-native-view-shot';
     *   initReactNative({ screenshot: { capture: captureScreen } });
     */
    capture?: CaptureFn;
    /** JPEG quality 0–1. JPEG at 0.5 is ~5x smaller than PNG and plenty here. */
    quality?: number;
    /**
     * Kept for compatibility and now IGNORED.
     *
     * It used to be relayed straight into the payload, so an app could claim a
     * screenshot was masked when nothing had been. What the panel shows is now
     * derived from whether a <ZanbugMask> cover was actually drawn.
     */
    masked?: boolean;
    /** Give up if the capture takes longer than this (ms). */
    timeoutMs?: number;
    /** Hard cap on the encoded image, in bytes. The server also rejects >3 MB. */
    maxBytes?: number;
}

const DEFAULTS = {
    quality: 0.5,
    timeoutMs: 1500,
    maxBytes: 2_500_000,
};

/**
 * Take a screenshot, or return null.
 *
 * Never rejects and never blocks longer than `timeoutMs`: this runs inside the
 * global error handler, where the app is already in trouble and a hanging
 * promise would delay the crash report — or the crash itself.
 */
export async function grabScreenshot(
    opts: ScreenshotOptions | undefined,
    screen: string | undefined,
): Promise<MobileScreenshot | null> {
    const capture = opts?.capture;
    if (typeof capture !== 'function') return null;

    const quality = opts?.quality ?? DEFAULTS.quality;
    const timeoutMs = opts?.timeoutMs ?? DEFAULTS.timeoutMs;
    const maxBytes = opts?.maxBytes ?? DEFAULTS.maxBytes;

    try {
        // Covers go up before the shutter and come down after — see mask.ts.
        // `didMask` is what actually happened, which is not always what the app
        // asked for: with no <ZanbugMask> mounted there is nothing to cover.
        const { value: shot, masked: didMask } = await withMasksCovered(() =>
            withTimeout(capture({ format: 'jpg', quality, result: 'base64' }), timeoutMs),
        );
        if (typeof shot !== 'string' || shot === '') return null;

        // Strip a data: prefix if the capture library added one — the server
        // accepts both, but sending the shorter form costs nothing.
        const data = shot.replace(/^data:image\/[a-z]+;base64,/i, '');

        // Base64 inflates by 4/3; compare against the DECODED size, which is
        // what the server's limit is expressed in.
        if (data.length * 0.75 > maxBytes) return null;

        return {
            kind: 'screenshot',
            data,
            screen,
            // Only true when a cover was actually drawn. Repeating the app's
            // `masked: true` regardless is how the panel ended up showing a
            // "masked" badge over a picture with a readable card number in it.
            masked: didMask,
            taken_at: new Date().toISOString(),
        };
    } catch {
        // A failed screenshot must never cost us the error it belonged to.
        return null;
    }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
            if (!done) {
                done = true;
                resolve(undefined);
            }
        }, ms);

        promise.then(
            (v) => {
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    resolve(v);
                }
            },
            () => {
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    resolve(undefined);
                }
            },
        );
    });
}
