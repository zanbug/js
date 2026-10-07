/**
 * The sliver of react-native this package needs at type level.
 *
 * Importing react-native's real types pulls in a second copy of @types/react,
 * and the two disagree about what `ReactNode` may contain (React 19 added
 * bigint), so every `<View>{children}</View>` failed to type-check. The runtime
 * import is untouched — react-native is external and Metro resolves it from the
 * host app; only the types are declared locally, structurally, and loosely.
 */
declare module 'react-native' {
    import type { ComponentType, ReactNode } from 'react';

    export interface ViewProps {
        children?: ReactNode;
        style?: unknown;
        pointerEvents?: 'auto' | 'none' | 'box-none' | 'box-only';
        collapsable?: boolean;
        [key: string]: unknown;
    }

    export const View: ComponentType<ViewProps>;

    export const Platform: { OS?: string; Version?: string | number; constants?: Record<string, unknown> };
    export const Dimensions: { get?: (dim: string) => { width: number; height: number; scale?: number } };
    export const AppState: {
        currentState?: string;
        addEventListener?: (type: string, cb: (state: string) => void) => { remove?: () => void } | void;
    };
    export const InteractionManager: {
        runAfterInteractions?: (cb: () => void) => { cancel?: () => void } | void;
    };
    export const NativeModules: Record<string, unknown>;
}
