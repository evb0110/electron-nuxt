import {
    mkdir,
    copyFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import esbuild from 'esbuild';

const { WORKER_BUNDLES } = await import(new URL('../packages/electron-worker-bundles/electronWorkerBundles.js', import.meta.url).href);

const builds = [
    {
        entryPoints: ['electron/main.ts'],
        format: 'cjs',
        outfile: 'dist-electron/main.cjs',
        banner: {js: 'const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;'},
        define: {'import.meta.url': '__importMetaUrl'},
        external: ['electron'],
    },
    {
        entryPoints: ['electron/preload.ts'],
        format: 'cjs',
        outfile: 'dist-electron/preload.cjs',
        external: ['electron'],
    },
    ...WORKER_BUNDLES.map(bundle => ({
        entryPoints: [bundle.entryPoint],
        format: bundle.format,
        outfile: `dist-electron/${bundle.fileName}`,
        external: ['electron'],
    })),
];

await rm('dist-electron', {
    recursive: true,
    force: true,
});
await mkdir('dist-electron', { recursive: true });

await Promise.all(builds.map(build => esbuild.build({
    bundle: true,
    platform: 'node',
    ...build,
})));

await copyFile('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', 'dist-electron/pdf.worker.mjs');
// Pin dist-electron/*.js to ESM semantics regardless of loader heuristics.
// worker_threads resolves module type from the nearest package.json; the
// asar-unpacked copy of this directory has no other package.json above it.
await writeFile('dist-electron/package.json', `${JSON.stringify({ type: 'module' }, null, 4)}\n`);
