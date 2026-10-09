import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    // ES2018 keeps async/await native while still parsing in every browser
    // released since ~2018. Going newer would drop older Safari for no gain.
    target: 'es2018',
    platform: 'neutral',
});
