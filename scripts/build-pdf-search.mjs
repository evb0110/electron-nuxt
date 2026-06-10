import { spawnSync } from 'node:child_process';
import {
    chmod,
    copyFile,
    mkdir,
    rm,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRequestedNativeRustTarget } from './native-rust-targets.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const target = getRequestedNativeRustTarget();
const binaryName = `evb-pdf-search${target.binaryExtension}`;
const cargoArgs = [
    'build',
    '--manifest-path',
    'native/pdf-search/Cargo.toml',
    '--release',
    '--locked',
    ...target.cargoTargetArgs,
];

const result = spawnSync('cargo', cargoArgs, {
    cwd: projectRoot,
    stdio: 'inherit',
});
if (result.status !== 0) {
    throw new Error(`cargo ${cargoArgs.join(' ')} failed with status ${result.status ?? 'unknown'}`);
}

const sourcePath = path.join(projectRoot, 'native', 'pdf-search', ...target.cargoReleaseDirSegments, binaryName);
const stageDir = path.join(projectRoot, '.tmp', 'pdf-search', target.platformArch, 'bin');
const destinationPath = path.join(stageDir, binaryName);

await rm(stageDir, {
    recursive: true,
    force: true,
});
await mkdir(stageDir, {recursive: true});
await copyFile(sourcePath, destinationPath);
if (target.platform !== 'win32') {
    await chmod(destinationPath, 0o755);
}

console.log(`Staged ${binaryName} for ${target.platformArch}: ${path.relative(projectRoot, destinationPath)}`);
