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
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    target: 'es2018',
    define,
    // Peers stay external: bundling them would give the host app a second copy.
    external: ['vue', '@zanbug/js'],
});
