import { spawnSync } from 'node:child_process';
import {
    mkdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_WEB_WASM_ASSETS } from './check-web-deploy-assets.mjs';

const defaultProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wasmTarget = 'wasm32-unknown-unknown';
const requiredExportsByRelativePath = new Map(
    REQUIRED_WEB_WASM_ASSETS.map(asset => [
        asset.relativePath,
        asset.requiredExports,
    ]),
);

export const WASM_FRESHNESS_ARTIFACTS = [
    {
        builtFileName: 'evb_pdf_image_combine.wasm',
        crateName: 'pdf-image-combine',
        label: 'PDF image combine WASM',
        manifestPath: 'native/pdf-image-combine/Cargo.toml',
        publicRelativePath: 'public/wasm/evb-pdf-image-combine.wasm',
        requiredExports: requiredExportsByRelativePath.get('wasm/evb-pdf-image-combine.wasm') ?? [],
        rustflags: [],
    },
    {
        builtFileName: 'evb_pdf_page_ops.wasm',
        crateName: 'pdf-page-ops',
        label: 'PDF page ops WASM',
        manifestPath: 'native/pdf-page-ops/Cargo.toml',
        publicRelativePath: 'public/wasm/evb-pdf-page-ops.wasm',
        requiredExports: requiredExportsByRelativePath.get('wasm/evb-pdf-page-ops.wasm') ?? [],
        rustflags: ['--cfg getrandom_backend="custom"'],
    },
];

function appendRustflags(env, rustflags) {
    return [
        env.RUSTFLAGS,
        ...rustflags,
    ].filter(Boolean).join(' ');
}

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
        builtPath: path.join(cargoTargetDir, wasmTarget, 'release', artifact.builtFileName),
        cargoArgs: [
            'build',
            '--manifest-path',
            artifact.manifestPath,
            '--release',
            '--locked',
            '--target',
            wasmTarget,
            '--lib',
        ],
        cargoEnv,
        cargoTargetDir,
        publicPath: path.join(projectRoot, artifact.publicRelativePath),
    };
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
    projectRoot = defaultProjectRoot,
    readFileImpl = readFile,
    runCommand = runCommandSync,
} = {}) {
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
            byteLength: publicBytes.byteLength,
            fresh,
            publicPath: plan.publicPath,
        });

        if (!fresh) {
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
        const results = await checkWasmFreshness();
        const summary = results
            .map(result => `${path.relative(defaultProjectRoot, result.publicPath)} (${result.byteLength} bytes)`)
            .join(', ');
        console.log(`WASM freshness check passed for ${summary}.`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
