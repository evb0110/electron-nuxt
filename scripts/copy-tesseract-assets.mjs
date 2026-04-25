import {
    cp,
    mkdir,
} from 'node:fs/promises';
import {
    dirname,
    join,
} from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDir);

const tesseractRoot = dirname(require.resolve('tesseract.js/package.json'));
const tesseractCoreRoot = join(dirname(tesseractRoot), 'tesseract.js-core');
const publicTesseractRoot = join(projectRoot, 'public', 'tesseract');
const publicTesseractCoreRoot = join(publicTesseractRoot, 'core');

const CORE_FILES = [
    'tesseract-core.wasm.js',
    'tesseract-core-simd.wasm.js',
    'tesseract-core-lstm.wasm.js',
    'tesseract-core-simd-lstm.wasm.js',
    'tesseract-core-relaxedsimd.wasm.js',
    'tesseract-core-relaxedsimd-lstm.wasm.js',
    'tesseract-core.wasm',
    'tesseract-core-simd.wasm',
    'tesseract-core-lstm.wasm',
    'tesseract-core-simd-lstm.wasm',
    'tesseract-core-relaxedsimd.wasm',
    'tesseract-core-relaxedsimd-lstm.wasm',
    'tesseract-core.js',
    'tesseract-core-simd.js',
    'tesseract-core-lstm.js',
    'tesseract-core-simd-lstm.js',
    'tesseract-core-relaxedsimd.js',
    'tesseract-core-relaxedsimd-lstm.js',
];

async function copyTesseractAssets() {
    await mkdir(publicTesseractRoot, { recursive: true });
    await mkdir(publicTesseractCoreRoot, { recursive: true });

    await cp(
        join(tesseractRoot, 'dist', 'worker.min.js'),
        join(publicTesseractRoot, 'worker.min.js'),
        { force: true },
    );

    for (const fileName of CORE_FILES) {
        await cp(
            join(tesseractCoreRoot, fileName),
            join(publicTesseractCoreRoot, fileName),
            { force: true },
        );
    }
}

try {
    await copyTesseractAssets();
} catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`Failed to copy Tesseract assets: ${message}`);
    process.exitCode = 1;
}
