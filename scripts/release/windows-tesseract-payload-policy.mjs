#!/usr/bin/env node
import {
    readdirSync,
    statSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const WINDOWS_TESSERACT_PAYLOAD_LIMITS = Object.freeze({
    totalBytes: 176 * 1024 * 1024,
    libtesseractBytes: 105 * 1024 * 1024,
    icuDataBytes: 32 * 1024 * 1024,
});

export function measureWindowsTesseractPayload(binDirectory) {
    const files = readdirSync(binDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => ({
            name: entry.name,
            bytes: statSync(path.join(binDirectory, entry.name)).size,
        }));

    return {
        files,
        totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    };
}

export function verifyWindowsTesseractPayload({
    binDirectory,
    limits = WINDOWS_TESSERACT_PAYLOAD_LIMITS,
}) {
    const measurement = measureWindowsTesseractPayload(binDirectory);
    const errors = [];
    const libtesseract = measurement.files.find(file => /^libtesseract.*\.dll$/iu.test(file.name));
    const icuData = measurement.files.find(file => /^libicudt.*\.dll$/iu.test(file.name));

    if (!libtesseract) errors.push('Missing libtesseract DLL');
    if (measurement.totalBytes > limits.totalBytes) {
        errors.push(`Tesseract payload is ${measurement.totalBytes} bytes; budget is ${limits.totalBytes}`);
    }
    if (libtesseract && libtesseract.bytes > limits.libtesseractBytes) {
        errors.push(`${libtesseract.name} is ${libtesseract.bytes} bytes; budget is ${limits.libtesseractBytes}`);
    }
    if (icuData && icuData.bytes > limits.icuDataBytes) {
        errors.push(`${icuData.name} is ${icuData.bytes} bytes; budget is ${limits.icuDataBytes}`);
    }

    return {
        errors,
        measurement,
    };
}

function runCli() {
    const binDirectory = process.argv[2];
    if (!binDirectory) {
        console.error('Usage: windows-tesseract-payload-policy.mjs <tesseract-bin-directory>');
        process.exit(2);
    }

    const {
        errors,
        measurement,
    } = verifyWindowsTesseractPayload({ binDirectory });
    console.log(`Windows Tesseract payload: ${measurement.totalBytes} bytes across ${measurement.files.length} files`);
    for (const error of errors) console.error(`Error: ${error}`);
    if (errors.length > 0) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) runCli();
