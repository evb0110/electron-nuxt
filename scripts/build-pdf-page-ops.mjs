import { spawnSync } from 'node:child_process';
import {
    chmod,
    copyFile,
    mkdir,
    rm,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const platformByNodePlatform = {
    darwin: 'darwin',
    linux: 'linux',
    win32: 'win32',
};
const archByNodeArch = {
    arm64: 'arm64',
    x64: 'x64',
};

const platform = platformByNodePlatform[process.platform];
const arch = archByNodeArch[process.arch];
if (!platform || !arch) {
    throw new Error(`Unsupported platform for pdf-page-ops: ${process.platform}-${process.arch}`);
}

const platformArch = `${platform}-${arch}`;
const binaryName = platform === 'win32'
    ? 'evb-pdf-page-ops.exe'
    : 'evb-pdf-page-ops';
const cargoArgs = [
    'build',
    '--manifest-path',
    'native/pdf-page-ops/Cargo.toml',
    '--release',
    '--locked',
];

const result = spawnSync('cargo', cargoArgs, {
    cwd: projectRoot,
    stdio: 'inherit',
});
if (result.status !== 0) {
    throw new Error(`cargo ${cargoArgs.join(' ')} failed with status ${result.status ?? 'unknown'}`);
}

const sourcePath = path.join(projectRoot, 'native', 'pdf-page-ops', 'target', 'release', binaryName);
const stageDir = path.join(projectRoot, '.tmp', 'pdf-page-ops', platformArch, 'bin');
const destinationPath = path.join(stageDir, binaryName);

await rm(stageDir, {
    recursive: true,
    force: true,
});
await mkdir(stageDir, {recursive: true});
await copyFile(sourcePath, destinationPath);
if (platform !== 'win32') {
    await chmod(destinationPath, 0o755);
}

console.log(`Staged ${binaryName} for ${platformArch}: ${path.relative(projectRoot, destinationPath)}`);
