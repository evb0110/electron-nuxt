import { spawnSync } from 'node:child_process';
import {
    chmod,
    mkdir,
    rm,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import {
    copyCargoArtifactVerified,
    getCargoArtifactPath,
    resolveCargoTargetDirectory,
} from './cargo-artifacts.mjs';
import { getRequestedNativeRustTarget } from './native-rust-targets.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = `Usage: node scripts/build-native-tool.mjs <tool> [--dry-run]

Builds a generated native tool from the canonical native resource manifest.
Use --dry-run to resolve and print the build plan without invoking Cargo.`;

export function createNativeToolBuildPlan({
    projectRoot: root,
    target,
    tool,
}) {
    const manifestPath = `native/${tool.crateName}/Cargo.toml`;
    const binaryName = `${tool.binaryName}${target.binaryExtension}`;
    return {
        binaryName,
        cargoArgs: [
            'build',
            '--manifest-path',
            manifestPath,
            '--release',
            '--locked',
            ...target.cargoTargetArgs,
        ],
        destinationPath: path.join(root, '.tmp', tool.stagingName, target.platformArch, 'bin', binaryName),
        manifestPath,
        platform: target.platform,
        platformArch: target.platformArch,
        rustTarget: target.isHostTarget ? undefined : target.rustTarget,
    };
}

async function resolveTool(toolId) {
    const { getGeneratedNativeToolResource } = await tsImport(
        './nativeResourceManifest.ts',
        import.meta.url,
    );
    return getGeneratedNativeToolResource(toolId);
}

export async function runNativeToolBuilder(argv = process.argv.slice(2)) {
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
    const tool = await resolveTool(positional[0]);
    const target = getRequestedNativeRustTarget();
    const plan = createNativeToolBuildPlan({
        projectRoot,
        target,
        tool,
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
    const result = spawnSync('cargo', plan.cargoArgs, {
        cwd: projectRoot,
        stdio: 'inherit',
    });
    if (result.status !== 0) {
        throw new Error(`cargo ${plan.cargoArgs.join(' ')} failed with status ${result.status ?? 'unknown'}`);
    }

    const sourcePath = getCargoArtifactPath({
        fileName: plan.binaryName,
        rustTarget: plan.rustTarget,
        targetDirectory: cargoTargetDirectory,
    });
    const stageDir = path.dirname(plan.destinationPath);
    await rm(stageDir, {
        recursive: true,
        force: true,
    });
    await mkdir(stageDir, {recursive: true});
    const stagedArtifact = await copyCargoArtifactVerified(sourcePath, plan.destinationPath);
    if (plan.platform !== 'win32') {
        await chmod(plan.destinationPath, 0o755);
    }

    console.log(
        `Staged ${plan.binaryName} for ${plan.platformArch}: `
        + `${path.relative(projectRoot, plan.destinationPath)} (${stagedArtifact.sha256})`,
    );
}

const isDirectRun = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
    await runNativeToolBuilder().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
