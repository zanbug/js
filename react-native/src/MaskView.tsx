/**
 * <ZanbugMask> — wrap anything that must not appear in a screenshot.
 *
 *   import { ZanbugMask } from '@zanbug/react-native/mask';
 *
 *   <ZanbugMask>
 *     <TextInput value={cardNumber} />
 *   </ZanbugMask>
 *
 * The child renders and behaves normally; only while a screenshot is being taken
 * is an opaque cover laid over it. See mask.ts for why this is the only way to
 * mask on React Native, and what the previous (non-working) advice was.
 *
 * ---
 *
 * Why this lives at its own entry point, and why the imports below are static:
 *
 * The package's main entry must stay importable from plain Node — the SDK's own
 * test harness does that, with no react-native installed — so it cannot import
 * react-native at all. A component obviously needs React, hence the split.
 *
 * The first attempt resolved `react` through a runtime `require` to keep one
 * entry point. That crashed every release build on launch: Metro's production
 * bundle only accepts NUMERIC module ids, so `require('react')` answers with
 * `Error: Requiring unknown module "react"` — thrown from Metro's own module
 * registry during render, where it takes the app down. A static import is
 * resolved at build time and has none of that fragility.
 */
import * as React from 'react';
import { View } from 'react-native';

import { isCovering, registerMask, subscribeMask } from './mask';

/** The colour of the cover. Deliberately opaque and boring. */
const COVER = '#1a2333';

export interface ZanbugMaskProps {
    children?: React.ReactNode;
    /** Override the cover colour, e.g. to match a dark theme. */
    color?: string;
    /** Set false to disable masking for this instance without unwrapping it. */
    enabled?: boolean;
}

export function ZanbugMask(props: ZanbugMaskProps): React.ReactElement {
    const enabled = props.enabled !== false;
    const [covered, setCovered] = React.useState<boolean>(() => (enabled ? isCovering() : false));

    React.useEffect(() => {
        if (!enabled) return undefined;

        const unregister = registerMask();
        const unsubscribe = subscribeMask(() => setCovered(isCovering()));
        // A capture may already be in flight when this mounts.
        setCovered(isCovering());

        return () => {
            unsubscribe();
            unregister();
        };
    }, [enabled]);

    return (
        <View>
            {props.children}
            {/* The children stay mounted underneath: a cover, not an unmount, so
                no input loses its value and nothing reflows while the shutter is
                open. */}
            {enabled && covered ? (
                <View
                    pointerEvents="none"
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundColor: props.color ?? COVER,
                    }}
                />
            ) : null}
        </View>
    );
}
