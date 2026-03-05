import {
    cp,
    mkdir,
} from 'node:fs/promises';
import {
    dirname,
    join,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDir);
const pdfjsRoot = join(projectRoot, 'node_modules', 'pdfjs-dist');
const publicPdfRoot = join(projectRoot, 'public', 'pdf');

const ASSET_DIRECTORIES = [
    'standard_fonts',
    'cmaps',
    'wasm',
    'iccs',
];

async function copyPdfjsAssets() {
    await mkdir(publicPdfRoot, { recursive: true });
    for (const directory of ASSET_DIRECTORIES) {
        await mkdir(join(publicPdfRoot, directory), { recursive: true });
    }

    await cp(
        join(pdfjsRoot, 'build', 'pdf.worker.min.mjs'),
        join(publicPdfRoot, 'pdf.worker.min.mjs'),
        { force: true },
    );

    for (const directory of ASSET_DIRECTORIES) {
        await cp(
            join(pdfjsRoot, directory),
            join(publicPdfRoot, directory),
            {
                recursive: true,
                force: true,
            },
        );
    }
}

copyPdfjsAssets().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`Failed to copy PDF.js assets: ${message}`);
    process.exitCode = 1;
});
