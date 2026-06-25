import { spawnSync } from 'node:child_process';
import {
    mkdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    appendRustflags,
    WASM_ARTIFACTS,
    WASM_TARGET,
} from './wasm-artifacts.mjs';

const defaultProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STRICT_MODE = 'strict';
const PORTABLE_MODE = 'portable';
const WASM_FRESHNESS_MODES = new Set([
    STRICT_MODE,
    PORTABLE_MODE,
]);

export const WASM_FRESHNESS_ARTIFACTS = WASM_ARTIFACTS;

export function getWasmFreshnessBuildPlan(artifact, {
    env = process.env,
    projectRoot = defaultProjectRoot,
} = {}) {
    const cargoTargetDir = path.join(projectRoot, '.tmp', 'wasm-freshness', artifact.crateName, 'target');
    const cargoEnv = {
        ...env,
        CARGO_TARGET_DIR: cargoTargetDir,
    };
    const rustflags = appendRustflags(env, artifact.rustflags ?? []);
    if (rustflags) {
        cargoEnv.RUSTFLAGS = rustflags;
    }

    return {
        builtPath: path.join(cargoTargetDir, WASM_TARGET, 'release', artifact.builtFileName),
        cargoArgs: [
            'build',
            '--manifest-path',
            artifact.manifestPath,
            '--release',
            '--locked',
            '--target',
            WASM_TARGET,
            '--lib',
        ],
        cargoEnv,
        cargoTargetDir,
        publicPath: path.join(projectRoot, artifact.publicRelativePath),
    };
}

export function normalizeWasmFreshnessMode(mode = STRICT_MODE) {
    const normalizedMode = String(mode || STRICT_MODE).trim();
    if (WASM_FRESHNESS_MODES.has(normalizedMode)) {
        return normalizedMode;
    }

    throw new Error(
        `Unsupported WASM freshness mode "${mode}". Expected one of: ${Array.from(WASM_FRESHNESS_MODES).join(', ')}`,
    );
}

export function readWasmFreshnessMode(argv = process.argv.slice(2), env = process.env) {
    let mode = env.EVB_WASM_FRESHNESS_MODE || STRICT_MODE;

    for (const arg of argv) {
        if (arg === '--strict') {
            mode = STRICT_MODE;
            continue;
        }
        if (arg === '--portable') {
            mode = PORTABLE_MODE;
            continue;
        }
        if (arg.startsWith('--mode=')) {
            mode = arg.slice('--mode='.length);
            continue;
        }

        throw new Error(`Unsupported WASM freshness argument: ${arg}`);
    }

    return normalizeWasmFreshnessMode(mode);
}

export function runCommandSync(command, args, options) {
    const result = spawnSync(command, args, options);
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed with status ${result.status ?? 'unknown'}`);
    }
}

function getWasmExportNames(wasmBytes) {
    const wasmModule = new WebAssembly.Module(wasmBytes);
    return new Set(WebAssembly.Module.exports(wasmModule).map(entry => entry.name));
}

function assertWasmExports(label, wasmBytes, requiredExports) {
    const exportNames = getWasmExportNames(wasmBytes);
    const missingExports = requiredExports.filter(name => !exportNames.has(name));
    if (missingExports.length > 0) {
        throw new Error(`${label} is missing exports: ${missingExports.join(', ')}`);
    }
}

export async function checkWasmFreshness({
    artifacts = WASM_FRESHNESS_ARTIFACTS,
    mode = STRICT_MODE,
    projectRoot = defaultProjectRoot,
    readFileImpl = readFile,
    runCommand = runCommandSync,
} = {}) {
    const normalizedMode = normalizeWasmFreshnessMode(mode);
    const mismatches = [];
    const results = [];

    for (const artifact of artifacts) {
        const plan = getWasmFreshnessBuildPlan(artifact, {projectRoot});
        await mkdir(plan.cargoTargetDir, {recursive: true});
        runCommand('cargo', plan.cargoArgs, {
            cwd: projectRoot,
            env: plan.cargoEnv,
            stdio: 'inherit',
        });

        const publicBytes = await readFileImpl(plan.publicPath);
        const builtBytes = await readFileImpl(plan.builtPath);
        assertWasmExports(`${artifact.label} public artifact`, publicBytes, artifact.requiredExports);
        assertWasmExports(`${artifact.label} fresh build`, builtBytes, artifact.requiredExports);

        const fresh = Buffer.compare(Buffer.from(publicBytes), Buffer.from(builtBytes)) === 0;
        results.push({
            builtPath: plan.builtPath,
            builtByteLength: builtBytes.byteLength,
            byteLength: publicBytes.byteLength,
            fresh,
            mode: normalizedMode,
            publicPath: plan.publicPath,
        });

        if (normalizedMode === STRICT_MODE && !fresh) {
            mismatches.push(
                `${artifact.label}: ${path.relative(projectRoot, plan.publicPath)} differs from ${path.relative(projectRoot, plan.builtPath)}`,
            );
        }
    }

    if (mismatches.length > 0) {
        throw new Error([
            'Committed WASM artifacts are stale.',
            ...mismatches,
            'Run the WASM build scripts and commit the updated public/wasm artifacts.',
        ].join('\n'));
    }

    return results;
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    try {
        const mode = readWasmFreshnessMode();
        const results = await checkWasmFreshness({mode});
        const summary = results
            .map((result) => {
                const publicPath = path.relative(defaultProjectRoot, result.publicPath);
                if (mode === PORTABLE_MODE) {
                    return `${publicPath} (public ${result.byteLength} bytes, fresh build ${result.builtByteLength} bytes)`;
                }

                return `${publicPath} (${result.byteLength} bytes)`;
            })
            .join(', ');
        console.log(
            mode === PORTABLE_MODE
                ? `WASM portable check passed for ${summary}.`
                : `WASM freshness check passed for ${summary}.`,
        );
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
