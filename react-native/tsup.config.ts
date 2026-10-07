import { readFileSync } from 'fs';
import { defineConfig } from 'tsup';

// The package's own name/version, baked in so the install ping can report
// exactly which @zanbug/* adapter is installed (package.json stays the only
// place the version is written).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const define = {
    __ZANBUG_PKG__: JSON.stringify(pkg.name),
    __ZANBUG_PKG_VERSION__: JSON.stringify(pkg.version),
};

export default defineConfig({
    // Two entries on purpose. The main one must stay importable from plain
    // Node — the test harness does exactly that — so it never touches
    // `react-native`. <ZanbugMask> needs React, so it lives at
    // `@zanbug/react-native/mask` and imports react/react-native statically.
    // Resolving them through a runtime `require` instead does NOT work: Metro's
    // release bundle only accepts numeric module ids and answers a string with
    // "Requiring unknown module \"react\"", which crashed the app on launch.
    entry: { index: 'src/index.ts', mask: 'src/MaskView.tsx' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    target: 'es2018',
    define,
    // react-native and every optional native module stay external. Metro
    // resolves them from the host app; bundling them here would either fail at
    // build time (they are not installed in this monorepo) or ship a second
    // copy of react into the app.
    external: [
        'react',
        'react-native',
        '@zanbug/js',
        '@react-native-async-storage/async-storage',
        'react-native-view-shot',
        'expo-constants',
    ],
});
