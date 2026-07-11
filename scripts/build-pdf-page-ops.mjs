import { spawnSync } from 'node:child_process';
import {
    chmod,
    mkdir,
    rm,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    copyCargoArtifactVerified,
    getCargoArtifactPath,
    resolveCargoTargetDirectory,
} from './cargo-artifacts.mjs';
import { getRequestedNativeRustTarget } from './native-rust-targets.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const target = getRequestedNativeRustTarget();
const binaryName = `evb-pdf-page-ops${target.binaryExtension}`;
const cargoArgs = [
    'build',
    '--manifest-path',
    'native/pdf-page-ops/Cargo.toml',
    '--release',
    '--locked',
    ...target.cargoTargetArgs,
];
const cargoTargetDirectory = resolveCargoTargetDirectory({
    manifestPath: 'native/pdf-page-ops/Cargo.toml',
    projectRoot,
});

const result = spawnSync('cargo', cargoArgs, {
    cwd: projectRoot,
    stdio: 'inherit',
});
if (result.status !== 0) {
    throw new Error(`cargo ${cargoArgs.join(' ')} failed with status ${result.status ?? 'unknown'}`);
}

const sourcePath = getCargoArtifactPath({
    fileName: binaryName,
    rustTarget: target.isHostTarget ? undefined : target.rustTarget,
    targetDirectory: cargoTargetDirectory,
});
const stageDir = path.join(projectRoot, '.tmp', 'pdf-page-ops', target.platformArch, 'bin');
const destinationPath = path.join(stageDir, binaryName);

await rm(stageDir, {
    recursive: true,
    force: true,
});
await mkdir(stageDir, {recursive: true});
const stagedArtifact = await copyCargoArtifactVerified(sourcePath, destinationPath);
if (target.platform !== 'win32') {
    await chmod(destinationPath, 0o755);
}

console.log(`Staged ${binaryName} for ${target.platformArch}: ${path.relative(projectRoot, destinationPath)} (${stagedArtifact.sha256})`);
