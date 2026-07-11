import { spawnSync } from 'node:child_process';
import {
    mkdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    copyCargoArtifactVerified,
    getCargoArtifactPath,
    resolveCargoTargetDirectory,
} from './cargo-artifacts.mjs';
import {
    getWasmArtifactByCrateName,
    WASM_TARGET,
} from './wasm-artifacts.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = getWasmArtifactByCrateName('pdf-image-combine');
const cargoTargetDirectory = resolveCargoTargetDirectory({
    manifestPath: artifact.manifestPath,
    projectRoot,
});
const sourcePath = getCargoArtifactPath({
    fileName: artifact.builtFileName,
    rustTarget: WASM_TARGET,
    targetDirectory: cargoTargetDirectory,
});
const destinationPath = path.join(projectRoot, artifact.publicRelativePath);

const cargoArgs = [
    'build',
    '--manifest-path',
    artifact.manifestPath,
    '--release',
    '--locked',
    '--target',
    WASM_TARGET,
    '--lib',
];

const result = spawnSync('cargo', cargoArgs, {
    cwd: projectRoot,
    stdio: 'inherit',
});
if (result.status !== 0) {
    throw new Error(`cargo ${cargoArgs.join(' ')} failed with status ${result.status ?? 'unknown'}`);
}

await mkdir(path.dirname(destinationPath), {recursive: true});
await copyCargoArtifactVerified(sourcePath, destinationPath);

const wasmBytes = await readFile(destinationPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
const exportNames = new Set(WebAssembly.Module.exports(wasmModule).map(entry => entry.name));
const missingExports = artifact.requiredExports.filter(name => !exportNames.has(name));
if (missingExports.length > 0) {
    throw new Error(`PDF image combine WASM is missing exports: ${missingExports.join(', ')}`);
}

console.log(`Staged PDF image combine WASM: ${path.relative(projectRoot, destinationPath)} (${wasmBytes.byteLength} bytes)`);
