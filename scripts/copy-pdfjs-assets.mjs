import {
    cp,
    readFile,
    mkdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    join,
    resolve,
} from 'node:path';
import {
    fileURLToPath,
    pathToFileURL,
} from 'node:url';

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

const PDFJS_VERSION_STAMP_FILE = '.pdfjs-version';

export async function readPdfjsPackageVersion(root = pdfjsRoot) {
    const packageJsonPath = join(root, 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    if (typeof packageJson.version !== 'string' || packageJson.version.trim().length === 0) {
        throw new Error(`Missing pdfjs-dist version in ${packageJsonPath}`);
    }
    return packageJson.version.trim();
}

export async function writePdfjsVersionStamp({
    root = pdfjsRoot,
    targetRoot = publicPdfRoot,
} = {}) {
    const version = await readPdfjsPackageVersion(root);
    await mkdir(targetRoot, { recursive: true });
    await writeFile(join(targetRoot, PDFJS_VERSION_STAMP_FILE), `${version}\n`);
    return version;
}

export async function copyPdfjsAssets({
    root = pdfjsRoot,
    targetRoot = publicPdfRoot,
} = {}) {
    await mkdir(targetRoot, { recursive: true });
    for (const directory of ASSET_DIRECTORIES) {
        await rm(join(targetRoot, directory), {
            recursive: true,
            force: true,
        });
        await mkdir(join(targetRoot, directory), { recursive: true });
    }

    await cp(
        join(root, 'build', 'pdf.worker.min.mjs'),
        join(targetRoot, 'pdf.worker.min.mjs'),
        { force: true },
    );

    for (const directory of ASSET_DIRECTORIES) {
        await cp(
            join(root, directory),
            join(targetRoot, directory),
            {
                recursive: true,
                force: true,
            },
        );
    }

    await writePdfjsVersionStamp({
        root,
        targetRoot,
    });
}

if (pathToFileURL(resolve(process.argv[1] ?? '')).href === import.meta.url) {
    copyPdfjsAssets().catch((error) => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        console.error(`Failed to copy PDF.js assets: ${message}`);
        process.exitCode = 1;
    });
}
