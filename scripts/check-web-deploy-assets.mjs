import {
    readFile,
    stat,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const REQUIRED_WEB_WASM_ASSETS = [
    {
        relativePath: 'wasm/evb-pdf-image-combine.wasm',
        requiredExports: [
            'memory',
            'evb_pdf_image_combine_alloc',
            'evb_pdf_image_combine_free',
            'evb_pdf_image_combine_build_pdf',
            'evb_pdf_image_combine_output_ptr',
            'evb_pdf_image_combine_output_len',
            'evb_pdf_image_combine_error_ptr',
            'evb_pdf_image_combine_error_len',
        ],
    },
    {
        relativePath: 'wasm/evb-pdf-page-ops.wasm',
        requiredExports: [
            'memory',
            'evb_pdf_page_ops_alloc',
            'evb_pdf_page_ops_free',
            'evb_pdf_page_ops_run',
            'evb_pdf_page_ops_output_ptr',
            'evb_pdf_page_ops_output_len',
            'evb_pdf_page_ops_error_ptr',
            'evb_pdf_page_ops_error_len',
        ],
    },
];

function isVercelBuildOutputEnv(env = process.env) {
    return env.VERCEL === '1' || env.NOW_BUILDER === '1';
}

export function getExpectedWebDeployOutputRoots(env = process.env) {
    return isVercelBuildOutputEnv(env)
        ? ['.vercel/output/static']
        : ['nuxt-output/public'];
}

async function assertDirectory(dirPath, label) {
    let dirStat;
    try {
        dirStat = await stat(dirPath);
    } catch (error) {
        throw new Error(`Missing ${label}: ${dirPath}`, {cause: error});
    }

    if (!dirStat.isDirectory()) {
        throw new Error(`${label} is not a directory: ${dirPath}`);
    }
}

async function assertWasmAsset(rootPath, rootLabel, asset) {
    const assetPath = path.join(rootPath, asset.relativePath);
    let assetStat;
    try {
        assetStat = await stat(assetPath);
    } catch (error) {
        throw new Error(`Missing ${rootLabel} asset: ${asset.relativePath}`, {cause: error});
    }

    if (!assetStat.isFile() || assetStat.size <= 0) {
        throw new Error(`${rootLabel} asset is empty or not a file: ${asset.relativePath}`);
    }

    const wasmBytes = await readFile(assetPath);
    const wasmModule = new WebAssembly.Module(wasmBytes);
    const exportNames = new Set(WebAssembly.Module.exports(wasmModule).map(entry => entry.name));
    const missingExports = asset.requiredExports.filter(name => !exportNames.has(name));
    if (missingExports.length > 0) {
        throw new Error(
            `${rootLabel} asset ${asset.relativePath} is missing exports: ${missingExports.join(', ')}`,
        );
    }

    return {
        byteLength: wasmBytes.byteLength,
        path: assetPath,
    };
}

async function validateAssetRoot(rootPath, rootLabel) {
    await assertDirectory(rootPath, rootLabel);

    const assets = [];
    for (const asset of REQUIRED_WEB_WASM_ASSETS) {
        assets.push(await assertWasmAsset(rootPath, rootLabel, asset));
    }
    return assets;
}

export async function validateWebDeployAssets({
    env = process.env,
    outputRoots = getExpectedWebDeployOutputRoots(env),
    projectRoot = defaultProjectRoot,
    sourceRoot = 'public',
} = {}) {
    const sourceRootPath = path.join(projectRoot, sourceRoot);
    const sourceAssets = await validateAssetRoot(sourceRootPath, 'source public');

    const outputResults = [];
    for (const outputRoot of outputRoots) {
        const outputRootPath = path.join(projectRoot, outputRoot);
        outputResults.push({
            assets: await validateAssetRoot(outputRootPath, `web build output ${outputRoot}`),
            root: outputRoot,
        });
    }

    return {
        outputResults,
        sourceAssets,
    };
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    try {
        const result = await validateWebDeployAssets();
        const outputRoots = result.outputResults.map(entry => entry.root).join(', ');
        console.log(`Web deploy asset check passed for ${outputRoots}.`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
