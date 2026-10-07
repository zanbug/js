import type { EventStore } from '@zanbug/js';

/**
 * The offline queue's backing store.
 *
 * Mobile is the only runtime that genuinely needs one. A browser tab can flush
 * on `visibilitychange`; a server process can await flush() before exiting. A
 * phone loses signal in a lift, and a fatal JS error can kill the app before a
 * single request finishes — so events have to outlive the process, not just the
 * session.
 *
 * The store is supplied by the app rather than imported here, for the reason
 * spelled out in native.ts: Metro resolves requires statically, so importing
 * @react-native-async-storage/async-storage would break the bundle of every
 * customer who does not have it installed.
 */

/** The subset of AsyncStorage's API we use. MMKV and expo-secure-store fit too. */
export interface AsyncStorageLike {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
}

const QUEUE_KEY = '@zanbug/queue';

/**
 * Wrap an AsyncStorage-shaped object as an EventStore.
 *
 * Every method swallows its own failures: a full disk or a locked database must
 * degrade to "no offline queue", never to a rejected promise inside the host
 * app's error path.
 */
export function asyncStorageStore(storage: AsyncStorageLike, key: string = QUEUE_KEY): EventStore {
    return {
        load: async () => {
            try {
                return await storage.getItem(key);
            } catch {
                return null;
            }
        },
        save: async (raw: string) => {
            try {
                await storage.setItem(key, raw);
            } catch {
                /* ignore */
            }
        },
        clear: async () => {
            try {
                await storage.removeItem(key);
            } catch {
                /* ignore */
            }
        },
    };
}

/**
 * Marker used by the install ping so it fires once per install, not once per
 * launch. Separate key from the queue so clearing one never affects the other.
 */
export const PING_KEY = '@zanbug/pinged';
