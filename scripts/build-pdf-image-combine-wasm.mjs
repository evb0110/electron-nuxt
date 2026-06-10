import { spawnSync } from 'node:child_process';
import {
    copyFile,
    mkdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = 'wasm32-unknown-unknown';
const sourcePath = path.join(
    projectRoot,
    'native',
    'pdf-image-combine',
    'target',
    target,
    'release',
    'evb_pdf_image_combine.wasm',
);
const destinationPath = path.join(
    projectRoot,
    'public',
    'wasm',
    'evb-pdf-image-combine.wasm',
);
const requiredExports = [
    'memory',
    'evb_pdf_image_combine_alloc',
    'evb_pdf_image_combine_free',
    'evb_pdf_image_combine_build_pdf',
    'evb_pdf_image_combine_output_ptr',
    'evb_pdf_image_combine_output_len',
    'evb_pdf_image_combine_error_ptr',
    'evb_pdf_image_combine_error_len',
];

const cargoArgs = [
    'build',
    '--manifest-path',
    'native/pdf-image-combine/Cargo.toml',
    '--release',
    '--locked',
    '--target',
    target,
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
await copyFile(sourcePath, destinationPath);

const wasmBytes = await readFile(destinationPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
const exportNames = new Set(WebAssembly.Module.exports(wasmModule).map(entry => entry.name));
const missingExports = requiredExports.filter(name => !exportNames.has(name));
if (missingExports.length > 0) {
    throw new Error(`PDF image combine WASM is missing exports: ${missingExports.join(', ')}`);
}

console.log(`Staged PDF image combine WASM: ${path.relative(projectRoot, destinationPath)} (${wasmBytes.byteLength} bytes)`);
