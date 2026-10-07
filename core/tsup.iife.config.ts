import { defineConfig } from 'tsup';

/**
 * Standalone browser build for installs without npm.
 *
 * This is the JavaScript equivalent of the PHP SDK's composer-less mode: a
 * single file the customer drops in with a <script> tag, exposing `Zanbug` as a
 * global. Built separately from the module bundle because it needs a different
 * format (iife), minification, and no external imports at all.
 */
export default defineConfig({
    entry: { zanbug: 'src/index.ts' },
    outDir: 'dist/standalone',
    format: ['iife'],
    // window.Zanbug.init({...}) — the namespace object, not the module record,
    // so the global reads the same as the documented import.
    globalName: 'ZanbugSDK',
    minify: true,
    sourcemap: true,
    dts: false,
    clean: true,
    // Older browsers than the module build targets: a <script> tag install is
    // exactly the case where the customer has no bundler and no transpiler.
    target: 'es2017',
    platform: 'browser',
    // Node built-ins are unreachable in a browser but the loader references
    // them; stub them so esbuild does not try to resolve anything.
    define: { 'process.env.NODE_ENV': '"production"' },
    footer: {
        // Flatten the namespace: `Zanbug.init(...)` instead of
        // `ZanbugSDK.Zanbug.init(...)`.
        js: 'if (typeof window !== "undefined" && window.ZanbugSDK) { window.Zanbug = window.ZanbugSDK.Zanbug; }',
    },
});
