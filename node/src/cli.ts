/**
 * npx zanbug <command>
 *
 *   zanbug check                        exit 10 when a newer @zanbug/* release exists
 *   zanbug update [--yes] [--dry-run]   upgrade every @zanbug/* dependency of this project
 *   zanbug version
 *
 * Config: --key=… --host=… flags, else ZANBUG_API_KEY / ZANBUG_HOST env, else ./.env.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { SDK_VERSION } from '@zanbug/js';
import { checkForUpdate, updateSdk, detectProject, migrationHint } from './update';

const args = process.argv.slice(2);
let cmd = 'help';
const opts: Record<string, string | true> = {};
for (const a of args) {
    if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        if (eq === -1) opts[a.slice(2)] = true;
        else opts[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (cmd === 'help') {
        cmd = a;
    }
}

function dotenv(key: string): string {
    try {
        const file = path.join(process.cwd(), '.env');
        if (!fs.existsSync(file)) return '';
        for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
            const line = raw.trim();
            if (!line || line.startsWith('#') || !line.includes('=')) continue;
            const i = line.indexOf('=');
            if (line.slice(0, i).trim() !== key) continue;
            let v = line.slice(i + 1).trim();
            if (v.length > 1 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
            return v;
        }
    } catch {
        /* ignore */
    }
    return '';
}

const apiKey =
    (typeof opts.key === 'string' && opts.key) ||
    process.env.ZANBUG_API_KEY ||
    dotenv('ZANBUG_API_KEY') ||
    process.env.BUGBAN_API_KEY || dotenv('BUGBAN_API_KEY'); // legacy: bugban → zanbug (2026-10-07)
const host =
    (typeof opts.host === 'string' && opts.host) ||
    process.env.ZANBUG_HOST ||
    dotenv('ZANBUG_HOST') ||
    process.env.BUGBAN_HOST || dotenv('BUGBAN_HOST') || // legacy: bugban → zanbug (2026-10-07)
    'https://zanbug.com';
const say = (line: string) => process.stdout.write(line + '\n');
const fail = (line: string) => process.stderr.write('zanbug: ' + line + '\n');

function confirm(question: string): Promise<boolean> {
    return new Promise((resolve) => {
        if (!process.stdin.isTTY) return resolve(false);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => {
            rl.close();
            resolve(/^y(es)?$/i.test(answer.trim()));
        });
    });
}

async function main(): Promise<number> {
    switch (cmd) {
        case 'version':
        case '-v':
        case '--version':
            say(SDK_VERSION);
            return 0;

        case 'check': {
            const r = await checkForUpdate({ apiKey, host });
            if (r.error) {
                fail(r.error);
                return 1;
            }
            if (r.updateAvailable) {
                say('update available: ' + r.current + ' -> ' + r.latest + '  (run: npx zanbug update)');
                return 10;
            }
            say('up to date: ' + r.current);
            return 0;
        }

        case 'update': {
            const dryRun = opts['dry-run'] === true;
            const check = await checkForUpdate({ apiKey, host });
            if (check.error) {
                fail(check.error);
                return 1;
            }
            const project = detectProject();
            if (project.legacy.length > 0) fail(migrationHint(project.legacy)); // legacy: bugban → zanbug (2026-10-07)
            if (!check.updateAvailable) {
                say('up to date: ' + check.current);
                return project.legacy.length > 0 ? 1 : 0; // legacy: bugban → zanbug (2026-10-07)
            }
            say('current: ' + check.current + '   latest: ' + check.latest + '   project: ' + (project.root || 'not found') + (project.root ? ' (' + project.manager + ')' : ''));
            if (!project.root) {
                fail('no package.json with @zanbug/* dependencies found — run this inside your project');
                return 1;
            }
            if (project.packages.length === 0) return 1;
            if (!dryRun && opts.yes !== true) {
                if (!process.stdin.isTTY) {
                    fail('not a terminal; pass --yes to update non-interactively');
                    return 1;
                }
                if (!(await confirm('Update ' + project.packages.join(', ') + ' to ^' + check.latest + '? [y/N] '))) {
                    say('aborted');
                    return 1;
                }
            }
            const r = await updateSdk({ apiKey, host, dryRun, log: say });
            say((r.ok ? 'OK: ' : 'FAILED: ') + r.message);
            return r.ok ? 0 : 1;
        }

        default:
            say('zanbug ' + SDK_VERSION);
            say('');
            say('  zanbug check                        exit 10 when a newer SDK is published');
            say('  zanbug update [--yes] [--dry-run]   upgrade @zanbug/* packages in this project');
            say('  zanbug version');
            say('');
            say('  --key=<api key> --host=<panel url>  (default: ZANBUG_API_KEY / ZANBUG_HOST, or ./.env; BUGBAN_* still accepted)');
            return cmd === 'help' ? 0 : 1;
    }
}

main().then(
    (code) => process.exit(code),
    (e) => {
        fail(e instanceof Error ? e.message : String(e));
        process.exit(1);
    },
);
