import { spawnSync } from 'node:child_process';
import {
    mkdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import {
    copyCargoArtifactVerified,
    getCargoArtifactPath,
    resolveCargoTargetDirectory,
} from './cargo-artifacts.mjs';
import {
    appendRustflags,
    getWasmArtifactByCrateName,
    WASM_TARGET,
} from './wasm-artifacts.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = `Usage: node scripts/build-wasm-tool.mjs <tool> [--dry-run]

Builds a browser WASM tool registered by the canonical native resource manifest.
Use --dry-run to resolve and print the build plan without invoking Cargo.`;

export function createWasmToolBuildPlan({
    artifact,
    env = process.env,
    projectRoot: root,
}) {
    return {
        builtFileName: artifact.builtFileName,
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
        destinationPath: path.join(root, artifact.publicRelativePath),
        label: artifact.label,
        manifestPath: artifact.manifestPath,
        requiredExports: artifact.requiredExports,
        rustflags: appendRustflags(env, artifact.rustflags),
    };
}

async function resolveTool(toolId) {
    const { getGeneratedNativeToolResource } = await tsImport(
        './nativeResourceManifest.ts',
        import.meta.url,
    );
    const tool = getGeneratedNativeToolResource(toolId);
    return {
        artifact: getWasmArtifactByCrateName(tool.crateName),
        tool,
    };
}

export async function runWasmToolBuilder(argv = process.argv.slice(2)) {
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(usage);
        return;
    }

    const dryRun = argv.includes('--dry-run');
    const positional = argv.filter(arg => arg !== '--dry-run');
    if (positional.length !== 1) {
        throw new Error(usage);
    }

    const { generateNativeToolProtocols } = await tsImport(
        './generateNativeToolProtocols.ts',
        import.meta.url,
    );
    await generateNativeToolProtocols();
    const {
        artifact,
        tool,
    } = await resolveTool(positional[0]);
    const plan = createWasmToolBuildPlan({
        artifact,
        projectRoot,
    });
    if (dryRun) {
        console.log(JSON.stringify({
            tool,
            ...plan,
        }, null, 2));
        return;
    }

    const cargoTargetDirectory = resolveCargoTargetDirectory({
        manifestPath: plan.manifestPath,
        projectRoot,
    });
    const sourcePath = getCargoArtifactPath({
        fileName: plan.builtFileName,
        rustTarget: WASM_TARGET,
        targetDirectory: cargoTargetDirectory,
    });
    const result = spawnSync('cargo', plan.cargoArgs, {
        cwd: projectRoot,
        env: {
            ...process.env,
            ...(plan.rustflags ? {RUSTFLAGS: plan.rustflags} : {}),
        },
        stdio: 'inherit',
    });
    if (result.status !== 0) {
        throw new Error(`cargo ${plan.cargoArgs.join(' ')} failed with status ${result.status ?? 'unknown'}`);
    }

    await mkdir(path.dirname(plan.destinationPath), {recursive: true});
    await copyCargoArtifactVerified(sourcePath, plan.destinationPath);
    const wasmBytes = await readFile(plan.destinationPath);
    const wasmModule = new WebAssembly.Module(wasmBytes);
    const exportNames = new Set(WebAssembly.Module.exports(wasmModule).map(entry => entry.name));
    const missingExports = plan.requiredExports.filter(name => !exportNames.has(name));
    if (missingExports.length > 0) {
        throw new Error(`${plan.label} is missing exports: ${missingExports.join(', ')}`);
    }

    console.log(
        `Staged ${plan.label}: ${path.relative(projectRoot, plan.destinationPath)} `
        + `(${wasmBytes.byteLength} bytes)`,
    );
}

const isDirectRun = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
    await runWasmToolBuilder().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
