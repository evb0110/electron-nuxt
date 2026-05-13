import {
    mkdir,
    copyFile,
    rm,
} from 'node:fs/promises';
import esbuild from 'esbuild';

const builds = [
    {
        entryPoints: ['electron/main.ts'],
        format: 'cjs',
        outfile: 'dist-electron/main.cjs',
        banner: {js: 'const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;'},
        define: {'import.meta.url': '__importMetaUrl'},
        external: [
            'electron',
            'electron-updater',
        ],
    },
    {
        entryPoints: ['electron/preload.ts'],
        format: 'cjs',
        outfile: 'dist-electron/preload.js',
        external: ['electron'],
    },
    {
        entryPoints: ['electron/image/pdfCombineWorker.ts'],
        format: 'esm',
        outfile: 'dist-electron/pdfCombineWorker.js',
        external: ['electron'],
    },
    {
        entryPoints: ['electron/features/documents/main/pdfConformanceWorker.ts'],
        format: 'esm',
        outfile: 'dist-electron/pdfConformanceWorker.js',
        external: ['electron'],
    },
    {
        entryPoints: ['electron/ocr/worker/main.ts'],
        format: 'esm',
        outfile: 'dist-electron/ocr-worker.js',
        external: ['electron'],
    },
    {
        entryPoints: ['electron/search/worker.ts'],
        format: 'esm',
        outfile: 'dist-electron/search-worker.js',
        external: ['electron'],
    },
    {
        entryPoints: ['electron/features/page-ops/main/cropWorker.ts'],
        format: 'esm',
        outfile: 'dist-electron/page-ops-cropWorker.js',
        external: ['electron'],
    },
    {
        entryPoints: ['electron/features/image-export/main/tiffCombineWorker.ts'],
        format: 'esm',
        outfile: 'dist-electron/image-export-tiff-worker.js',
        external: ['electron'],
    },
    {
        entryPoints: ['electron/features/djvu/main/pdfWorker.ts'],
        format: 'esm',
        outfile: 'dist-electron/djvu-pdfWorker.js',
        external: ['electron'],
    },
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
