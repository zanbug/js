/**
 * Access to React Native and its optional native modules.
 *
 * Metro resolves `require()` STATICALLY. A literal `require('react-native-view-shot')`
 * therefore fails the customer's bundle build when that package is not
 * installed — not at runtime, where a try/catch could save us, but during
 * `metro build`, with an unresolved-module error and no app at all. That is the
 * mobile version of the mixed-install fatal that took a customer's PHP site
 * down, and it is unacceptable for a monitoring SDK.
 *
 * So OPTIONAL modules are never imported here. The app passes them in (see
 * `initReactNative` options) — one line in the customer's code, and their
 * bundler resolves it because they really do have the package.
 *
 * `react-native` itself is imported STATICALLY, and that is a correction.
 * It used to be fetched with a runtime `require('react-native')`, which works
 * with the dev server and in Node — and silently fails in every RELEASE build,
 * because Metro's production bundle only accepts the numeric module ids it
 * assigned and answers a string with "Requiring unknown module". The result was
 * a production-only blind spot: no OS, no OS version, no device model and the
 * wrong framework on every event a real user produced. Verified on a release
 * APK, where `device` arrived as nothing but the SDK name.
 */
import * as ReactNative from 'react-native';

/** Anything RN-ish we touch, kept structural so no RN types are needed. */
export interface RNBits {
    AppState?: {
        currentState?: string;
        addEventListener?: (type: string, cb: (state: string) => void) => { remove?: () => void } | void;
    };
    Platform?: { OS?: string; Version?: string | number; constants?: Record<string, unknown> };
    Dimensions?: { get?: (dim: string) => { width: number; height: number; scale?: number } };
    InteractionManager?: { runAfterInteractions?: (cb: () => void) => { cancel?: () => void } | void };
    NativeModules?: Record<string, unknown>;
}

let cached: RNBits | null | undefined;

/** The `react-native` module, or null if something about it is unusable. */
export function rn(): RNBits | null {
    if (cached !== undefined) return cached ?? null;
    cached = null;
    try {
        const mod: any = ReactNative as any;
        // Interop: some bundlers hand back a namespace whose real exports sit
        // under `default`.
        cached = (mod && (mod.default && mod.default.Platform ? mod.default : mod)) || null;
    } catch {
        // Should not happen in an app, but a monitoring SDK never assumes.
    }
    return cached ?? null;
}

/** Are we actually running inside React Native (and not a browser or Node)? */
export function isReactNative(): boolean {
    try {
        const nav: any = (globalThis as any).navigator;
        if (nav && nav.product === 'ReactNative') return true;
    } catch {
        /* ignore */
    }
    return rn() !== null;
}

/** 'ios' | 'android' | 'web' | undefined */
export function platformOS(): string | undefined {
    try {
        return rn()?.Platform?.OS;
    } catch {
        return undefined;
    }
}

/** Is this an Expo app? Reported on the install ping so the panel can say so. */
export function isExpo(): boolean {
    try {
        const g: any = globalThis as any;
        if (g.expo || g.__expo || g.ExpoModules) return true;
        return Boolean(rn()?.NativeModules?.ExponentConstants);
    } catch {
        return false;
    }
}

/**
 * Device facts worth having on every mobile event: which OS build, which screen
 * size. A crash that only happens on small screens or on one Android version is
 * invisible without them.
 */
export function mobileDeviceInfo(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    try {
        const r = rn();
        if (r?.Platform) {
            out.os = r.Platform.OS;
            out.os_version = r.Platform.Version;
        }
        const win = r?.Dimensions?.get?.('window');
        if (win) {
            out.screen = { width: Math.round(win.width), height: Math.round(win.height), scale: win.scale };
        }
        if (isExpo()) out.expo = true;
    } catch {
        /* device info is a nicety, never a reason to lose the event */
    }
    return out;
}

/** react-native's ErrorUtils global, if this runtime has one. */
export interface ErrorUtilsLike {
    getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
    setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
}

export function errorUtils(): ErrorUtilsLike | null {
    try {
        const g: any = globalThis as any;
        const eu = g.ErrorUtils;
        return eu && typeof eu.setGlobalHandler === 'function' ? eu : null;
    } catch {
        return null;
    }
}
