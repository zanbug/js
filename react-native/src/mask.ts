/**
 * Real masking for React Native screenshots.
 *
 * A screenshot is pixels. Once `captureScreen` has run, nothing downstream can
 * tell a card number from any other dark rectangle — so anything sensitive has
 * to be hidden BEFORE the shutter, and on a phone the SDK cannot do that alone.
 *
 * The advice this replaces was simply wrong: wrapping a view in
 * `<View collapsable={false}>` with `renderToHardwareTextureAndroid` does NOT
 * make react-native-view-shot skip it. Verified on a real release APK — the
 * value `MASKME-4242-9999` came through perfectly legible while the payload
 * claimed `masked: true`. A reassuring label over an unmasked picture is worse
 * than no label.
 *
 * Flutter can paint over the rasterised image because it owns the canvas. Here
 * there is no canvas, so masking happens in the view tree: [ZanbugMask] lays an
 * opaque cover over its children for the duration of the capture. Children stay
 * mounted — a cover, not an unmount — so no state is lost and no layout shifts.
 */

/**
 * The state lives on globalThis, not in this module's scope.
 *
 * This file is bundled into BOTH entry points — the main one (which takes the
 * screenshot) and `/mask` (which holds the component) — so module scope means
 * TWO independent counters: the component registers itself in one copy while
 * the capture reads the other, finds nothing mounted, and reports
 * `masked: false` over a perfectly unmasked picture. Observed exactly that on a
 * release APK. A single well-known global cannot drift, however the consumer's
 * bundler decides to split things up.
 */
interface MaskState {
    mounted: number;
    covering: boolean;
    listeners: Set<() => void>;
}

const KEY = '__zanbug_mask_state_v1__';

function state(): MaskState {
    const g = globalThis as unknown as Record<string, MaskState | undefined>;
    let s = g[KEY];
    if (!s) {
        s = { mounted: 0, covering: false, listeners: new Set<() => void>() };
        g[KEY] = s;
    }
    return s;
}

function notify(): void {
    state().listeners.forEach((fn) => {
        try {
            fn();
        } catch {
            /* a listener must never break a capture */
        }
    });
}

export function registerMask(): () => void {
    const s = state();
    s.mounted += 1;
    return () => {
        s.mounted = Math.max(0, s.mounted - 1);
    };
}

export function subscribeMask(listener: () => void): () => void {
    const s = state();
    s.listeners.add(listener);
    return () => {
        s.listeners.delete(listener);
    };
}

export function isCovering(): boolean {
    return state().covering;
}

export function maskCount(): number {
    return state().mounted;
}

/** Wait for the covers to be painted before the shutter opens. */
function nextFrame(): Promise<void> {
    return new Promise((resolve) => {
        const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => void })
            .requestAnimationFrame;
        if (typeof raf === 'function') raf(() => resolve());
        else setTimeout(resolve, 16);
    });
}

/**
 * Run [capture] with every [ZanbugMask] covered.
 *
 * Returns whether masking actually happened, so the payload can state the truth
 * instead of repeating the app's intention. With no mask mounted the capture
 * runs untouched and `masked` is false — the app is then telling us the screen
 * has nothing to hide, which is its call to make, not ours to assume.
 */
export async function withMasksCovered<T>(
    capture: () => Promise<T>,
): Promise<{ value: T; masked: boolean }> {
    const s = state();
    if (s.mounted === 0) {
        return { value: await capture(), masked: false };
    }

    s.covering = true;
    notify();
    try {
        // Two frames: one for React to commit the re-render, one for the native
        // side to actually draw it. One was not always enough on a slow device,
        // and a capture that races the paint is an unmasked capture.
        await nextFrame();
        await nextFrame();
        return { value: await capture(), masked: true };
    } finally {
        // Uncover even if the capture threw, or the app is left with grey boxes
        // over its own UI — a monitoring bug the user would see.
        s.covering = false;
        notify();
    }
}
