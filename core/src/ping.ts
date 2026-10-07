import type { ResolvedOptions } from './types';
import type { Transport } from './transport';
import {
    SDK_NAME,
    SDK_VERSION,
    appPackageInfo,
    hostname,
    isBrowser,
    isNode,
    nodeModule,
    runtimeName,
    runtimeVersion,
} from './env';
import { safe } from './utils';

/**
 * One-time install ping.
 *
 * The panel needs to distinguish "the SDK is installed and quiet" from "the SDK
 * was never wired up" — otherwise a correctly working integration looks
 * identical to a broken one. This is the same handshake the PHP SDK sends;
 * `POST /api/ingest/ping` fills first_ping_at / last_ping_at / sdk_info and the
 * project page turns into "SDK connected ✓".
 *
 * Fires at most once per install. The marker differs by runtime because there
 * is no shared notion of persistent state: a temp file in Node, localStorage
 * in the browser (falling back to a per-page in-memory flag in private mode).
 */

const MARKER_KEY = 'zanbug.ping';
let memoryMarker = false;

async function alreadyPinged(apiKey: string, version: string): Promise<boolean> {
    const stamp = `${apiKey.slice(0, 12)}:${version}`;
    // version = SDK version + packages + auto-update flag (see sendInstallPing).

    if (isBrowser) {
        const stored = safe(() => localStorage.getItem(MARKER_KEY));
        if (stored === stamp) return true;
        safe(() => localStorage.setItem(MARKER_KEY, stamp));
        // Private mode throws on setItem — fall back to once per page load
        // rather than pinging on every single error.
        if (memoryMarker) return true;
        memoryMarker = true;
        return false;
    }

    if (isNode) {
        try {
            const [fs, os, path] = await Promise.all([
                nodeModule('fs'),
                nodeModule('os'),
                nodeModule('path'),
            ]);
            if (!fs || !os || !path || typeof fs.existsSync !== 'function') {
                // No filesystem access (bundled/edge runtime): degrade to
                // once per process instead of pinging on every error.
                if (memoryMarker) return true;
                memoryMarker = true;
                return false;
            }
            // Key prefix + a hash of the whole stamp: a bare hex slice would
            // cut off everything after the version and never re-ping.
            const key = toHex(stamp).slice(0, 24) + fnv1a(stamp);
            const file = path.join(os.tmpdir(), `.zanbug-ping-${key}`);
            if (fs.existsSync(file)) return true;
            fs.writeFileSync(file, stamp);
            return false;
        } catch {
            return false;
        }
    }

    if (memoryMarker) return true;
    memoryMarker = true;
    return false;
}

/** 32-bit FNV-1a as 8 hex chars — enough to tell two marker stamps apart. */
function fnv1a(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/** Buffer is not guaranteed outside Node, so the marker name is hashed by hand. */
function toHex(s: string): string {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        out += s.charCodeAt(i).toString(16);
    }
    return out;
}

export async function sendInstallPing(opts: ResolvedOptions, transport: Transport): Promise<void> {
    if (!opts.installPing || !opts.enabled) return;

    try {
        // Every @zanbug/* package in play, core first. A changed adapter
        // version or auto-update flag re-pings (it is part of the marker).
        const packages: Record<string, string> = { '@zanbug/js': SDK_VERSION };
        const extra = opts.sdkPackages;
        if (extra && typeof extra === 'object') {
            for (const name in extra) {
                const v = extra[name];
                if (typeof v === 'string' && v !== '' && name !== '@zanbug/js') packages[name] = v;
            }
        }
        const autoUpdate = opts.autoUpdate === true;
        const marker = `${SDK_VERSION}|${Object.keys(packages).sort().map(k => `${k}@${packages[k]}`).join(',')}|${autoUpdate ? 1 : 0}`;

        if (await alreadyPinged(opts.apiKey, marker)) return;

        const pkg = await appPackageInfo();
        const host = await hostname();

        const payload: Record<string, unknown> = {
            sdk: SDK_NAME,
            sdk_version: SDK_VERSION,
            framework: opts.framework || runtimeName(),
            framework_version: opts.frameworkVersion,
            environment: opts.environment,
            hostname: host,

            // The app's own identity. In Node this is read from package.json; in
            // the browser there is no filesystem, so it comes from `release`
            // (usually wired to the bundler's define) and the page host.
            app_name: pkg.name || (isBrowser ? safe(() => location.hostname) : undefined),
            app_version: opts.release || pkg.version,

            // Where the SDK is running, and that runtime's version: Node's
            // process.version, or the browser UA. The panel shows this the same
            // way it shows the PHP version for the PHP SDKs.
            runtime: runtimeName(),
            runtime_version: runtimeVersion(),

            packages,
            // Only the Node SDK can update itself (npx zanbug update); browser
            // and React Native bundles ship with the app build.
            auto_update: autoUpdate,
            auto_update_supported: isNode,
        };

        // Drop empty fields so a sparse ping never overwrites what the server
        // already learned from a richer one.
        for (const k in payload) {
            if (payload[k] == null || payload[k] === '') delete payload[k];
        }

        void transport.send('/api/ingest/ping', payload);
    } catch {
        // A failed handshake must never surface to the host application.
    }
}
