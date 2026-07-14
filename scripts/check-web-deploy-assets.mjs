import {
    readFile,
    stat,
} from 'node:fs/promises';
import path from 'node:path';
import {
    fileURLToPath,
    pathToFileURL,
} from 'node:url';
import {
    REQUIRED_WEB_DEPLOY_ASSETS,
    REQUIRED_WEB_OUTPUT_CONTRACTS,
    REQUIRED_WEB_WASM_ASSETS,
} from './web-deploy-asset-manifest.mjs';

const defaultProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export {
    REQUIRED_WEB_DEPLOY_ASSETS,
    REQUIRED_WEB_OUTPUT_CONTRACTS,
    REQUIRED_WEB_WASM_ASSETS,
};

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

async function assertFileAsset(rootPath, rootLabel, asset) {
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

    return {
        byteLength: assetStat.size,
        path: assetPath,
    };
}

async function assertWasmAsset(rootPath, rootLabel, asset) {
    const fileResult = await assertFileAsset(rootPath, rootLabel, asset);
    const wasmBytes = await readFile(fileResult.path);
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
        path: fileResult.path,
    };
}

async function validateAssetRoot(rootPath, rootLabel, {requireOutputContracts = false} = {}) {
    await assertDirectory(rootPath, rootLabel);

    const assets = [];
    for (const asset of REQUIRED_WEB_DEPLOY_ASSETS) {
        assets.push('requiredExports' in asset
            ? await assertWasmAsset(rootPath, rootLabel, asset)
            : await assertFileAsset(rootPath, rootLabel, asset));
    }
    if (requireOutputContracts) {
        for (const relativePath of REQUIRED_WEB_OUTPUT_CONTRACTS) {
            assets.push(await assertFileAsset(rootPath, rootLabel, {relativePath}));
        }
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
            assets: await validateAssetRoot(
                outputRootPath,
                `web build output ${outputRoot}`,
                {requireOutputContracts: true},
            ),
            root: outputRoot,
        });
    }

    return {
        outputResults,
        sourceAssets,
    };
}

export async function validateVercelFunctionBoot({projectRoot = defaultProjectRoot} = {}) {
    const entryPath = path.join(
        projectRoot,
        '.vercel/output/functions/__fallback.func/index.mjs',
    );
    await assertFileAsset(
        path.dirname(entryPath),
        'Vercel server function',
        {relativePath: path.basename(entryPath)},
    );

    try {
        await import(`${pathToFileURL(entryPath).href}?boot-check=${Date.now()}`);
    } catch (error) {
        throw new Error('Vercel server function failed to load', {cause: error});
    }
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    try {
        const result = await validateWebDeployAssets();
        if (isVercelBuildOutputEnv()) {
            await validateVercelFunctionBoot();
        }
        const outputRoots = result.outputResults.map(entry => entry.root).join(', ');
        console.log(`Web deploy asset check passed for ${outputRoots}.`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
