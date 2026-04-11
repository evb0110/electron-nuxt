import {
    mkdir,
    copyFile,
} from 'node:fs/promises';
import esbuild from 'esbuild';

const builds = [
    {
        entryPoints: ['electron/main.ts'],
        format: 'esm',
        outfile: 'dist-electron/main.js',
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
        entryPoints: ['electron/image/pdf-combine-worker.ts'],
        format: 'esm',
        outfile: 'dist-electron/pdf-combine-worker.js',
        external: ['electron'],
    },
    {
        entryPoints: ['electron/features/documents/main/pdf-conformance-worker.ts'],
        format: 'esm',
        outfile: 'dist-electron/pdf-conformance-worker.js',
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
        entryPoints: ['electron/features/page-ops/main/crop-worker.ts'],
        format: 'esm',
        outfile: 'dist-electron/page-ops-crop-worker.js',
        external: ['electron'],
    },
    {
        entryPoints: ['electron/features/image-export/main/tiff-combine-worker.ts'],
        format: 'esm',
        outfile: 'dist-electron/image-export-tiff-worker.js',
        external: ['electron'],
    },
    {
        entryPoints: ['electron/features/djvu/main/pdf-worker.ts'],
        format: 'esm',
        outfile: 'dist-electron/djvu-pdf-worker.js',
        external: ['electron'],
    },
];

await mkdir('dist-electron', { recursive: true });

await Promise.all(builds.map(build => esbuild.build({
    bundle: true,
    platform: 'node',
    ...build,
})));

await copyFile('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', 'dist-electron/pdf.worker.mjs');
