/**
 * Self-update for the Node SDK.
 *
 *   checkForUpdate()   GET <host>/api/ingest/latest and compare `latest.js` with SDK_VERSION
 *   updateSdk()        `npm|yarn|pnpm|bun install @zanbug/<pkg>@^<latest>` for every @zanbug/*
 *                      dependency of the nearest package.json (the CLI's `zanbug update`)
 *   maybeAutoUpdate()  opt-in daily hook (`autoUpdate: true` / ZANBUG_AUTO_UPDATE=true):
 *                      spawns `zanbug update --yes` detached, so the app never waits on it
 *
 * Node-only (fs / child_process); every function resolves, never throws.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { spawn, spawnSync } from 'child_process';
import { SDK_VERSION, legacyEnvKey } from '@zanbug/js';

export interface UpdateCheck {
    current: string;
    latest: string | null;
    updateAvailable: boolean;
    error: string | null;
}

export interface UpdateResult {
    ok: boolean;
    mode: 'npm' | 'yarn' | 'pnpm' | 'bun' | 'none';
    from: string;
    to: string | null;
    packages: string[];
    message: string;
    command?: string;
}

export interface UpdateOptions {
    apiKey?: string;
    host?: string;
    /** Directory to start the package.json search from. Default process.cwd(). */
    cwd?: string;
    dryRun?: boolean;
    /** Progress lines (package manager output is inherited on the CLI). */
    log?: (line: string) => void;
    timeoutMs?: number;
}

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function envOr(key: string, fallback = ''): string {
    const v = typeof process !== 'undefined' && process.env ? process.env[key] : undefined;
    if (v && v !== '') return v;
    const legacy = legacyEnvKey(key); // legacy: bugban → zanbug (2026-10-07)
    const lv = legacy && typeof process !== 'undefined' && process.env ? process.env[legacy] : undefined;
    return lv && lv !== '' ? lv : fallback;
}

/** // legacy: bugban → zanbug (2026-10-07): old scope still present in the customer's package.json. */
export const LEGACY_SCOPE = '@bugban/';
export function migrationHint(legacy: string[]): string {
    const to = legacy.map((p) => '@zanbug/' + p.slice(LEGACY_SCOPE.length));
    return (
        'this project still depends on ' + legacy.join(', ') + ' — the SDK moved to the @zanbug/* scope. ' +
        'Migrate with: npm uninstall ' + legacy.join(' ') + ' && npm install ' + to.join(' ') +
        '  (then rename the imports and ZANBUG_* env vars; BUGBAN_* env vars keep working as a fallback)'
    );
}

export function resolveCreds(o: UpdateOptions = {}): { apiKey: string; host: string } {
    return {
        apiKey: o.apiKey || envOr('ZANBUG_API_KEY') || envOr('NEXT_PUBLIC_ZANBUG_API_KEY'),
        host: (o.host || envOr('ZANBUG_HOST') || envOr('NEXT_PUBLIC_ZANBUG_HOST') || 'https://zanbug.com').replace(/\/+$/, ''),
    };
}

function getJson(url: string, apiKey: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
        let target: URL;
        try {
            target = new URL(url);
        } catch (e) {
            return reject(new Error('invalid host: ' + url));
        }
        const mod = target.protocol === 'http:' ? http : https;
        const req = mod.request(
            target,
            {
                method: 'GET',
                headers: { 'X-Zanbug-Key': apiKey, Accept: 'application/json', 'User-Agent': 'zanbug-node/' + SDK_VERSION },
                timeout: timeoutMs,
            },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (c) => (body += c));
                res.on('end', () => {
                    if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
                        return reject(new Error('HTTP ' + res.statusCode + (res.statusCode === 401 ? ' (api key rejected)' : '')));
                    }
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(new Error('non-JSON response'));
                    }
                });
            },
        );
        req.on('timeout', () => req.destroy(new Error('timed out after ' + timeoutMs + 'ms')));
        req.on('error', reject);
        req.end();
    });
}

function cmpVersions(a: string, b: string): number {
    const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
}

export async function checkForUpdate(o: UpdateOptions = {}): Promise<UpdateCheck> {
    const out: UpdateCheck = { current: SDK_VERSION, latest: null, updateAvailable: false, error: null };
    try {
        const { apiKey, host } = resolveCreds(o);
        if (!apiKey) {
            out.error = 'no api key configured (ZANBUG_API_KEY)';
            return out;
        }
        const data = await getJson(host + '/api/ingest/latest', apiKey, o.timeoutMs ?? 8000);
        const latest = data && data.latest && typeof data.latest.js === 'string' ? data.latest.js.trim() : '';
        if (!/^\d+\.\d+\.\d+/.test(latest)) {
            out.error = 'could not read the latest version from ' + host;
            return out;
        }
        out.latest = latest;
        out.updateAvailable = cmpVersions(latest, SDK_VERSION) > 0;
    } catch (e) {
        out.error = e instanceof Error ? e.message : String(e);
    }
    return out;
}

// ---- project detection ------------------------------------------------------

export interface ProjectInfo {
    root: string | null;
    packages: string[];
    /** // legacy: bugban → zanbug (2026-10-07): old-scope packages found next to (or instead of) @zanbug/*. */
    legacy: string[];
    manager: UpdateResult['mode'];
}

export function detectProject(cwd = process.cwd()): ProjectInfo {
    const info: ProjectInfo = { root: null, packages: [], legacy: [], manager: 'none' };
    let dir = path.resolve(cwd);
    for (let i = 0; i < 12; i++) {
        const pj = path.join(dir, 'package.json');
        if (fs.existsSync(pj)) {
            try {
                const json = JSON.parse(fs.readFileSync(pj, 'utf8'));
                const names = new Set<string>();
                const legacy = new Set<string>();
                for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
                    for (const name of Object.keys(json[section] || {})) {
                        if (name.startsWith('@zanbug/')) names.add(name);
                        else if (name.startsWith(LEGACY_SCOPE)) legacy.add(name); // legacy: bugban → zanbug (2026-10-07)
                    }
                }
                if (names.size > 0 || legacy.size > 0) {
                    info.root = dir;
                    info.legacy = Array.from(legacy).sort();
                    // core first, so a stale lock can never leave an old @zanbug/js behind
                    info.packages = Array.from(names).sort((a, b) => (a === '@zanbug/js' ? -1 : b === '@zanbug/js' ? 1 : a.localeCompare(b)));
                    info.manager = detectManager(dir);
                    return info;
                }
            } catch {
                /* unreadable package.json: keep walking up */
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return info;
}

/**
 * The project that actually holds the RUNNING copy of this SDK: the directory
 * whose node_modules contains us. Preferred over process.cwd() because the SDK
 * may be loaded with `node --require /opt/zanbug/node/x.init.cjs` from a sidecar
 * directory while the app's cwd has no @zanbug dependency at all — updating
 * the cwd project would then update nothing that is running.
 */
export function detectRunningProject(): ProjectInfo {
    try {
        const marker = path.sep + 'node_modules' + path.sep;
        const at = __dirname.lastIndexOf(marker);
        if (at > 0) {
            const found = detectProject(__dirname.slice(0, at));
            if (found.root) return found;
        }
    } catch {
        /* fall through to cwd */
    }
    return detectProject();
}

function detectManager(root: string): UpdateResult['mode'] {
    if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))) return 'bun';
    if (fs.existsSync(path.join(root, 'package-lock.json')) || fs.existsSync(path.join(root, 'npm-shrinkwrap.json'))) return 'npm';
    const ua = envOr('npm_config_user_agent');
    const m = /^(pnpm|yarn|bun|npm)\//.exec(ua);
    return (m ? (m[1] as UpdateResult['mode']) : 'npm');
}

function installArgs(manager: UpdateResult['mode'], specs: string[]): string[] {
    switch (manager) {
        case 'yarn':
            return ['add', ...specs];
        case 'pnpm':
            return ['add', ...specs];
        case 'bun':
            return ['add', ...specs];
        default:
            return ['install', '--no-audit', '--no-fund', ...specs];
    }
}

/**
 * Upgrade every @zanbug/* dependency of the nearest package.json to ^latest.
 * Package-manager output is streamed to the terminal (stdio inherit).
 */
export async function updateSdk(o: UpdateOptions = {}): Promise<UpdateResult> {
    const res: UpdateResult = { ok: false, mode: 'none', from: SDK_VERSION, to: null, packages: [], message: '' };
    try {
        const check = await checkForUpdate(o);
        if (check.error) {
            res.message = check.error;
            return res;
        }
        res.to = check.latest;
        const project = detectProject(o.cwd);
        if (project.legacy.length > 0) o.log?.('WARNING: ' + migrationHint(project.legacy)); // legacy: bugban → zanbug (2026-10-07)
        if (!check.updateAvailable) {
            res.ok = true;
            res.message = 'already up to date (' + SDK_VERSION + ')';
            if (project.legacy.length > 0) res.message += ' — ' + migrationHint(project.legacy); // legacy: bugban → zanbug (2026-10-07)
            return res;
        }
        if (!project.root) {
            res.message = 'no package.json with @zanbug/* dependencies found above ' + (o.cwd || process.cwd());
            return res;
        }
        if (project.packages.length === 0) {
            res.message = migrationHint(project.legacy); // legacy: bugban → zanbug (2026-10-07)
            return res;
        }
        res.mode = project.manager;
        res.packages = project.packages;
        const specs = project.packages.map((p) => p + '@^' + check.latest);
        const args = installArgs(project.manager, specs);
        const bin = project.manager === 'none' ? 'npm' : project.manager;
        res.command = [bin, ...args].join(' ');
        if (o.dryRun) {
            res.ok = true;
            res.message = '[dry-run] would run in ' + project.root + ': ' + res.command;
            return res;
        }
        o.log?.('$ ' + res.command + '   (in ' + project.root + ')');
        const r = spawnSync(bin, args, {
            cwd: project.root,
            stdio: o.log ? 'inherit' : 'pipe',
            shell: process.platform === 'win32',
            timeout: o.timeoutMs && o.timeoutMs > 60000 ? o.timeoutMs : 10 * 60 * 1000,
            env: { ...process.env, CI: process.env.CI || '1' },
        });
        if (r.error) {
            res.message = bin + ' could not be started: ' + r.error.message;
            return res;
        }
        if (r.status !== 0) {
            const tail = r.stderr ? String(r.stderr).trim().split('\n').slice(-5).join('\n') : '';
            res.message = bin + ' exited with code ' + r.status + (tail ? '\n' + tail : '');
            return res;
        }
        res.ok = true;
        res.message = 'updated ' + project.packages.join(', ') + ' to ^' + check.latest + ' — restart the Node process to load the new code';
    } catch (e) {
        res.message = e instanceof Error ? e.message : String(e);
    }
    return res;
}

// ---- opt-in daily hook --------------------------------------------------------

function markerPath(apiKey: string): string | null {
    try {
        const dir = os.tmpdir();
        let h = 0;
        const s = apiKey + '|' + __dirname;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return path.join(dir, '.zanbug-update-check-' + h.toString(16));
    } catch {
        return null;
    }
}

export function logPath(): string {
    return path.join(os.tmpdir(), 'zanbug-update.log');
}

/**
 * Called from initNode() when `autoUpdate` is on. At most once per 24h:
 * checks the panel and, if newer, runs `zanbug update --yes` detached in the
 * project root. Never blocks, never throws.
 */
export function maybeAutoUpdate(o: UpdateOptions = {}): void {
    try {
        const { apiKey } = resolveCreds(o);
        if (!apiKey) return;
        const marker = markerPath(apiKey);
        if (!marker) return;
        try {
            const st = fs.statSync(marker);
            if (Date.now() - st.mtimeMs < CHECK_INTERVAL_MS) return;
        } catch {
            /* no marker yet */
        }
        try {
            fs.writeFileSync(marker, String(Date.now()));
        } catch {
            return; // unwritable tmp: skip rather than re-check every boot
        }
        // Off the hot path: the app keeps booting while we ask the panel.
        setTimeout(() => {
            checkForUpdate(o)
                .then((check) => {
                    if (check.error || !check.updateAvailable) return;
                    const project = o.cwd ? detectProject(o.cwd) : detectRunningProject();
                    if (!project.root || project.packages.length === 0) return;
                    const cli = path.join(__dirname, 'cli.cjs');
                    if (!fs.existsSync(cli)) return;
                    const log = fs.openSync(logPath(), 'a');
                    fs.writeSync(log, '[' + new Date().toISOString() + '] auto-update ' + SDK_VERSION + ' -> ' + check.latest + '\n');
                    const child = spawn(process.execPath, [cli, 'update', '--yes'], {
                        cwd: project.root,
                        detached: true,
                        stdio: ['ignore', log, log],
                        env: { ...process.env, ZANBUG_API_KEY: resolveCreds(o).apiKey, ZANBUG_HOST: resolveCreds(o).host },
                    });
                    child.unref();
                    fs.closeSync(log);
                })
                .catch(() => undefined);
        }, 1500).unref?.();
    } catch {
        /* never let the updater affect the host app */
    }
}
