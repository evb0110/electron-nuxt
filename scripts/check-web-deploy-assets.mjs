import {
    readFile,
    stat,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
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
const execFileAsync = promisify(execFile);
const FORBIDDEN_INITIAL_RENDERER_DEPENDENCIES = [
    'pdf-lib',
    'utif',
    'pako',
];
const NODE_SERVER_BOOT_TIMINGS = Object.freeze({
    default: Object.freeze({
        healthDeadlineMs: 8_000,
        processTimeoutMs: 10_000,
    }),
    win32: Object.freeze({
        healthDeadlineMs: 30_000,
        processTimeoutMs: 35_000,
    }),
});
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

export function getNodeServerBootTiming(platform = process.platform) {
    return platform === 'win32'
        ? NODE_SERVER_BOOT_TIMINGS.win32
        : NODE_SERVER_BOOT_TIMINGS.default;
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

function readHtmlAttribute(tag, name) {
    const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'iu').exec(tag);
    return match?.[2] ?? null;
}

function collectModulePreloadPaths(html) {
    const paths = [];
    for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
        const tag = match[0];
        const rel = readHtmlAttribute(tag, 'rel');
        const href = readHtmlAttribute(tag, 'href');
        if (rel?.split(/\s+/u).includes('modulepreload') && href) {
            paths.push(href);
        }
    }
    return paths;
}

function collectStaticImportSpecifiers(source) {
    const specifiers = [];
    const pattern = /\b(?:import(?:[^"'();]*?\bfrom\s*)?|export[^"'();]*?\bfrom\s*)\s*["']([^"']+)["']/gu;
    for (const match of source.matchAll(pattern)) {
        specifiers.push(match[1]);
    }
    return specifiers;
}

function resolveLocalAssetPath(specifier, importerPath = '/') {
    if (
        !specifier.startsWith('/')
        && !specifier.startsWith('./')
        && !specifier.startsWith('../')
    ) {
        return null;
    }

    const baseUrl = new URL(importerPath, 'https://evb.local');
    const resolvedUrl = new URL(specifier, baseUrl);
    return resolvedUrl.origin === baseUrl.origin
        ? decodeURIComponent(resolvedUrl.pathname)
        : null;
}

export async function assertInitialRendererDependencyGraph(rootPath) {
    const htmlPath = path.join(rootPath, 'electron/index.html');
    const html = await readFile(htmlPath, 'utf8');
    const modulePreloads = collectModulePreloadPaths(html)
        .map(href => resolveLocalAssetPath(href))
        .filter(assetPath => assetPath !== null);
    const pending = [...modulePreloads];
    const visited = new Set();

    while (pending.length > 0) {
        const assetPath = pending.pop();
        if (!assetPath || visited.has(assetPath)) {
            continue;
        }
        visited.add(assetPath);

        const source = await readFile(path.join(rootPath, assetPath.slice(1)), 'utf8');
        const forbiddenDependency = FORBIDDEN_INITIAL_RENDERER_DEPENDENCIES.find(
            dependency => new RegExp(`\\b${dependency}\\b`, 'iu').test(source),
        );
        if (forbiddenDependency) {
            throw new Error(
                `Initial renderer dependency graph contains ${forbiddenDependency}: ${assetPath}`,
            );
        }

        for (const specifier of collectStaticImportSpecifiers(source)) {
            const importedAssetPath = resolveLocalAssetPath(specifier, assetPath);
            if (importedAssetPath && !visited.has(importedAssetPath)) {
                pending.push(importedAssetPath);
            }
        }
    }

    return {
        modulePreloads,
        staticAssets: [...visited],
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
        await assertInitialRendererDependencyGraph(rootPath);
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

export async function validateNodeServerBoot({projectRoot = defaultProjectRoot} = {}) {
    const entryPath = path.join(projectRoot, 'nuxt-output/server/index.mjs');
    await assertFileAsset(
        path.dirname(entryPath),
        'Nuxt node server',
        {relativePath: path.basename(entryPath)},
    );

    const port = await new Promise((resolve, reject) => {
        const reservation = createServer();
        reservation.once('error', reject);
        reservation.listen(0, '127.0.0.1', () => {
            const address = reservation.address();
            if (!address || typeof address === 'string') {
                reservation.close();
                reject(new Error('Unable to reserve a loopback port for the Nuxt boot check.'));
                return;
            }
            reservation.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(address.port);
            });
        });
    });
    const entryUrl = pathToFileURL(entryPath).href;
    const healthUrl = `http://127.0.0.1:${String(port)}/`;
    const timing = getNodeServerBootTiming();
    try {
        await execFileAsync(process.execPath, [
            '--input-type=module',
            '--eval',
            [
                `await import(${JSON.stringify(entryUrl)});`,
                `const deadline = Date.now() + ${String(timing.healthDeadlineMs)};`,
                'let booted = false;',
                'let lastError;',
                'while (Date.now() < deadline) {',
                '  try {',
                `    const response = await fetch(${JSON.stringify(healthUrl)}, {signal: AbortSignal.timeout(1_000)});`,
                '    await response.body?.cancel();',
                '    booted = true;',
                '    process.emit("SIGTERM", "SIGTERM");',
                '    break;',
                '  } catch (error) {',
                '    lastError = error;',
                '    await new Promise(resolve => setTimeout(resolve, 50));',
                '  }',
                '}',
                'if (!booted) {',
                '  throw lastError ?? new Error("Nuxt server did not answer its loopback health request.");',
                '}',
            ].join('\n'),
        ], {
            env: {
                ...process.env,
                HOST: '127.0.0.1',
                NITRO_HOST: '127.0.0.1',
                NITRO_PORT: String(port),
                PORT: String(port),
            },
            timeout: timing.processTimeoutMs,
        });
    } catch (error) {
        const childOutput = [
            error?.stdout,
            error?.stderr,
        ]
            .filter(output => typeof output === 'string' && output.trim().length > 0)
            .map(output => output.trim())
            .join('\n');
        const details = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Nuxt node server failed to boot: ${details}${childOutput ? `\n${childOutput}` : ''}`,
            {cause: error},
        );
    }
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    try {
        const result = await validateWebDeployAssets();
        if (isVercelBuildOutputEnv()) {
            await validateVercelFunctionBoot();
        } else {
            await validateNodeServerBoot();
        }
        const outputRoots = result.outputResults.map(entry => entry.root).join(', ');
        console.log(`Web deploy asset check passed for ${outputRoots}.`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
