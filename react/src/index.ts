/**
 * Zanbug SDK for React.
 *
 * A thin layer over @zanbug/js: the core already captures window.onerror,
 * unhandled rejections, console errors, network failures and Web Vitals. What
 * React adds is the one thing the core cannot see — errors thrown during
 * render, which React swallows and turns into a blank screen unless an error
 * boundary catches them.
 *
 * Works with Vite, Create React App, Parcel or any bundler; there is nothing
 * Vite-specific here.
 */

import * as React from 'react';
import { Zanbug, init as coreInit, capture } from '@zanbug/js';
import type { ZanbugOptions } from '@zanbug/js';

// Injected by tsup (see tsup.config.ts) from this package's package.json.
declare const __ZANBUG_PKG__: string;
declare const __ZANBUG_PKG_VERSION__: string;
/** This adapter's own entry for the install ping's package list. */
function withOwnPackage(extra?: Record<string, string>): Record<string, string> {
    return { ...(extra || {}), [__ZANBUG_PKG__]: __ZANBUG_PKG_VERSION__ };
}

export * from '@zanbug/js';

/**
 * Initialise Zanbug for a React app.
 *
 * Call once, as early as possible — above ReactDOM.createRoot in main.tsx.
 */
export function initReact(options: ZanbugOptions = {}) {
    return coreInit({
        framework: 'react',
        frameworkVersion: readReactVersion(),
        ...options,
        sdkPackages: withOwnPackage(options.sdkPackages),
    });
}

function readReactVersion(): string | undefined {
    try {
        // React exposes its own version at runtime, so there is no need to
        // read package.json (which does not exist in a browser bundle).
        return (React as unknown as { version?: string }).version;
    } catch {
        return undefined;
    }
}

export interface ErrorBoundaryProps {
    children?: React.ReactNode;
    /**
     * What to show instead of the crashed subtree. Given the error and a
     * `reset` callback that re-mounts the children.
     */
    fallback?: React.ReactNode | ((error: Error, reset: () => void) => React.ReactNode);
    /** Called after the error is reported — for your own logging or UI state. */
    onError?: (error: Error, componentStack: string) => void;
    /**
     * Remount the children when any value in this array changes. Use it to
     * recover on route change: `resetKeys={[location.pathname]}`.
     */
    resetKeys?: unknown[];
}

interface ErrorBoundaryState {
    error: Error | null;
}

/**
 * Catches render-time errors in the subtree and reports them to Zanbug.
 *
 * React only supports class components for this — there is no hook equivalent,
 * because the mechanism (componentDidCatch) predates hooks and has never been
 * ported.
 */
export class ZanbugErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = { error: null };

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo): void {
        const componentStack = (info && info.componentStack) || '';

        // The component stack is the single most useful piece of context for a
        // React crash — it names the component tree that produced it, which a
        // minified JS stack trace cannot.
        // Reached the error boundary = nothing above caught it → UNHANDLED
        // (Bugsnag semantics). Explicit useZanbugCapture() stays handled.
        capture(error, {
            handled: false,
            type: 'react.render',
            context: { react: { component_stack: componentStack.slice(0, 8000) } },
        });

        try {
            this.props.onError?.(error, componentStack);
        } catch {
            /* a broken onError must not replace the original error */
        }
    }

    componentDidUpdate(prev: ErrorBoundaryProps): void {
        // Only reset when the keys actually changed, otherwise every parent
        // re-render would clear a genuine error and cause a render loop.
        if (this.state.error && changed(prev.resetKeys, this.props.resetKeys)) {
            this.reset();
        }
    }

    reset = (): void => {
        this.setState({ error: null });
    };

    render(): React.ReactNode {
        const { error } = this.state;
        if (!error) return this.props.children ?? null;

        const { fallback } = this.props;
        if (typeof fallback === 'function') {
            return (fallback as (e: Error, reset: () => void) => React.ReactNode)(error, this.reset);
        }
        return fallback ?? null;
    }
}

function changed(a?: unknown[], b?: unknown[]): boolean {
    if (a === b) return false;
    if (!a || !b || a.length !== b.length) return true;
    for (let i = 0; i < a.length; i++) {
        if (!Object.is(a[i], b[i])) return true;
    }
    return false;
}

/**
 * Report an error from inside a component — event handlers and effects, which
 * error boundaries do NOT catch.
 *
 *   const report = useZanbugCapture();
 *   try { await save(); } catch (e) { report(e); }
 */
export function useZanbugCapture() {
    return React.useCallback(
        (error: unknown, context?: Record<string, unknown>) =>
            capture(error, { handled: true, type: 'react.handler', context }),
        [],
    );
}

/**
 * Wrap a component in an error boundary without adding JSX to your tree.
 *
 *   export default withZanbug(Dashboard, { fallback: <Oops /> });
 */
export function withZanbug<P extends object>(
    Component: React.ComponentType<P>,
    boundaryProps: Omit<ErrorBoundaryProps, 'children'> = {},
): React.ComponentType<P> {
    const Wrapped = (props: P) =>
        React.createElement(
            ZanbugErrorBoundary,
            boundaryProps,
            React.createElement(Component, props),
        );

    Wrapped.displayName = `withZanbug(${Component.displayName || Component.name || 'Component'})`;
    return Wrapped;
}

export { Zanbug };
