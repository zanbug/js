/**
 * Runtime detection and environment facts.
 *
 * Every lookup is defensive: this file runs in browsers, in Node, in edge
 * runtimes, and during SSR where `window` exists but `document` does not.
 * Nothing here may throw — a crash in environment detection would take down
 * the host application on import, which is exactly the failure the PHP SDK
 * learned to avoid the hard way.
 */

export const SDK_NAME = 'zanbug-js';
export const SDK_VERSION = '2.0.1';

export const isBrowser: boolean = (() => {
    try {
        return typeof window !== 'undefined' && typeof window.document !== 'undefined';
    } catch {
        return false;
    }
})();

export const isNode: boolean = (() => {
    try {
        return (
            typeof process !== 'undefined' &&
            process.versions != null &&
            process.versions.node != null
        );
    } catch {
        return false;
    }
})();

/**
 * React Native sets `navigator.product` to 'ReactNative'. It also defines
 * `window` — but not `window.document` — so `isBrowser` above is already false
 * there and the two never collide.
 */
export const isReactNative: boolean = (() => {
    try {
        return (
            typeof navigator !== 'undefined' &&
            (navigator as { product?: string }).product === 'ReactNative'
        );
    } catch {
        return false;
    }
})();

/** 'browser' | 'mobile' | 'node' | 'unknown' — reported on the install ping. */
export function runtimeName(): string {
    // Checked before Node: Metro can define `process`, and a phone reported as
    // a server would land in the wrong half of the panel.
    if (isReactNative) return 'mobile';
    if (isBrowser) return 'browser';
    if (isNode) return 'node';
    return 'unknown';
}

/**
 * The runtime's own version: Node's `v22.13.1`, or the browser's UA string.
 * The panel shows this next to the framework version, the same way it shows
 * the PHP version for the PHP SDKs.
 */
export function runtimeVersion(): string | undefined {
    try {
        if (isReactNative) {
            // navigator.userAgent is absent on RN; the mobile adapter supplies
            // the OS and its version through `device` instead.
            return undefined;
        }
        if (isNode) return process.versions.node;
        if (isBrowser) return navigator.userAgent;
    } catch {
        /* ignore */
    }
    return undefined;
}

/**
 * Extra facts merged into every event's `device`, set by init({ device }).
 *
 * The browser and Node branches of deviceInfo() below can read what they need
 * from global APIs. React Native cannot: OS version and screen size live in
 * the `react-native` module, which this file must never import (see the mobile
 * adapter's native.ts for why a static import breaks Metro builds). So the
 * adapter passes them in.
 */
let deviceExtra: Record<string, unknown> = {};

export function setDeviceExtra(extra: Record<string, unknown> | undefined | null): void {
    deviceExtra = extra && typeof extra === 'object' ? extra : {};
}

/**
 * Compile `import(spec)` at runtime, so no bundler's parser ever sees the call.
 *
 * A written-out `import(spec)` with a computed specifier is not merely awkward
 * for bundlers — **Metro rejects it outright**: "Invalid call ... import(spec)",
 * which fails the BUILD. Every React Native app that installed the SDK stopped
 * compiling, and the ignore comments that keep Vite and webpack quiet do
 * nothing for Metro. Found by building a real release APK; the Node test
 * harness never runs Metro, so nothing before it could have caught this.
 *
 * Built lazily and only on Node: `new Function` is blocked by a strict CSP, and
 * evaluating it at module scope would throw in a browser that has one.
 */
let dynamicImport: ((spec: string) => Promise<any>) | null | undefined;

function getDynamicImport(): ((spec: string) => Promise<any>) | null {
    if (dynamicImport !== undefined) return dynamicImport;
    try {
        dynamicImport = new Function('s', 'return import(s)') as (spec: string) => Promise<any>;
    } catch {
        // No eval available (strict CSP), or an engine without dynamic import.
        dynamicImport = null;
    }
    return dynamicImport;
}

/**
 * Load a Node built-in without letting any bundler see it.
 *
 * Four constraints collide here:
 *   1. In ESM there is no `require`, so the old `globalThis.require` trick
 *      silently returned undefined and the SDK went quiet on modern Node.
 *   2. In a browser bundle a literal `import('http')` makes Vite/webpack try
 *      to resolve — and warn or fail — even though the call is unreachable.
 *   3. Metro refuses to bundle a dynamic import at all when the specifier is
 *      not a literal, so the call cannot appear in the source (see above).
 *   4. Customers run old Node. `node:` prefixes need 14.18+, and dynamic
 *      import itself needs 12.17+, so every step needs a fallback.
 */
export async function nodeModule(name: string): Promise<any> {
    if (!isNode) return undefined;

    const load = getDynamicImport();
    if (load) {
        // Computed on purpose — a literal would be statically analysable.
        const prefixed = 'node:'.concat(name);
        for (const spec of [prefixed, String(name)]) {
            try {
                const ns: any = await load(spec);
                if (ns) return ns.default && !ns.hostname && !ns.existsSync ? ns.default : ns;
            } catch {
                /* try the next specifier */
            }
        }
    }

    return tryRequire(name);
}

/** Best-effort hostname — the machine for Node, the site for a browser. */
export async function hostname(): Promise<string | undefined> {
    try {
        if (isBrowser) return window.location.hostname;
        if (isNode) {
            const os = await nodeModule('os');
            if (os && typeof os.hostname === 'function') return String(os.hostname());
        }
    } catch {
        /* ignore */
    }
    return undefined;
}

/**
 * Read the host application's name/version from its package.json (Node only).
 * Browsers have no filesystem, so there `release` must be passed to init() —
 * usually wired to the bundler's define (e.g. Vite's import.meta.env).
 */
export async function appPackageInfo(): Promise<{ name?: string; version?: string }> {
    if (!isNode) return {};
    try {
        const fs = await nodeModule('fs');
        const path = await nodeModule('path');
        if (!fs || !path || typeof fs.existsSync !== 'function') return {};

        // Walk up from the working directory: in a monorepo the nearest
        // package.json is the app being run, not the repo root.
        let dir = process.cwd();
        for (let depth = 0; depth < 6; depth++) {
            const file = path.join(dir, 'package.json');
            if (fs.existsSync(file)) {
                const json = JSON.parse(fs.readFileSync(file, 'utf8'));
                return { name: json.name, version: json.version };
            }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    } catch {
        /* ignore */
    }
    return {};
}

/**
 * Read a dependency's version out of the host app's node_modules, so an
 * adapter can report "react 19.0.0" without importing react itself.
 */
export async function dependencyVersion(pkg: string): Promise<string | undefined> {
    if (!isNode) return undefined;
    try {
        const mod = await nodeModule('module');
        if (mod && typeof mod.createRequire === 'function') {
            const r = mod.createRequire(process.cwd() + '/package.json');
            const json = r(`${pkg}/package.json`);
            return json && json.version ? String(json.version) : undefined;
        }
    } catch {
        /* the dependency may simply not be installed */
    }
    return undefined;
}

/**
 * // legacy: bugban → zanbug (2026-10-07): an app that still exports the old BUGBAN_* variable names keeps
 * working — the old name is read only when the ZANBUG_* one is unset.
 */
export function legacyEnvKey(key: string): string | undefined {
    if (key.startsWith('ZANBUG_')) return 'BUGBAN_' + key.slice('ZANBUG_'.length);
    if (key.startsWith('NEXT_PUBLIC_ZANBUG_')) return 'NEXT_PUBLIC_BUGBAN_' + key.slice('NEXT_PUBLIC_ZANBUG_'.length);
    return undefined;
}

/** Environment variable read that is safe in the browser. */
export function env(key: string): string | undefined {
    try {
        if (typeof process !== 'undefined' && process.env) {
            let v = process.env[key];
            if (v == null || v === '') {
                const legacy = legacyEnvKey(key); // legacy: bugban → zanbug (2026-10-07)
                v = legacy ? process.env[legacy] : undefined;
            }
            return v == null || v === '' ? undefined : String(v);
        }
    } catch {
        /* ignore */
    }
    return undefined;
}

/**
 * CommonJS require that bundlers do not statically analyse. Returns undefined
 * in ESM-only or browser contexts instead of throwing.
 */
function tryRequire(name: string): any {
    try {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const req: any =
            typeof module !== 'undefined' && typeof (module as any).require === 'function'
                ? (module as any).require
                : typeof (globalThis as any).require === 'function'
                  ? (globalThis as any).require
                  : undefined;
        return req ? req(name) : undefined;
    } catch {
        return undefined;
    }
}

/** Device/app context sent with every event. */
export function deviceInfo(): Record<string, unknown> {
    const out: Record<string, unknown> = {
        sdk: SDK_NAME,
        sdk_version: SDK_VERSION,
        runtime: runtimeName(),
        runtime_version: runtimeVersion(),
    };

    try {
        if (isBrowser) {
            out.user_agent = navigator.userAgent;
            out.language = navigator.language;
            out.screen = { width: window.screen?.width, height: window.screen?.height };
            out.viewport = { width: window.innerWidth, height: window.innerHeight };
            out.online = navigator.onLine;
        }
        if (isNode) {
            out.platform = process.platform;
            out.arch = process.arch;
            out.pid = process.pid;
        }
    } catch {
        /* ignore */
    }

    // Last, so an adapter can correct anything the generic detection got wrong.
    try {
        Object.assign(out, deviceExtra);
    } catch {
        /* ignore */
    }

    return out;
}

/**
 * Synchronous Node built-in loader (`os`, `fs`, ...). The run tracker needs
 * `fs` at startup to walk /proc for its parent processes; waiting on an async
 * import there would race the first query. Order: `process.getBuiltinModule`
 * (Node 20.16+/22.3+, works under ESM), then CJS `require` with and without
 * the `node:` prefix. Returns undefined when none of them is available — the
 * caller must treat that as "feature not available", never as an error.
 */
export function nodeBuiltin(name: string): any {
    if (!isNode) return undefined;
    try {
        const p: any = process;
        if (typeof p.getBuiltinModule === 'function') {
            const m = p.getBuiltinModule('node:'.concat(name)) || p.getBuiltinModule(name);
            if (m) return m;
        }
    } catch {
        /* fall through */
    }
    return tryRequire('node:'.concat(name)) || tryRequire(name);
}
