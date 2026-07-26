import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    computeReleaseBuildState,
    validateReleaseBuildReceipt,
    writeReleaseBuildReceipt,
} from '@scripts/release/build-receipt.mjs';

function fakeToolchain(command: string, args: string[]) {
    return `${command} ${args.join(' ')} test-version`;
}

describe('release strict-build receipts', () => {
    it('accepts exact input/output reuse and rejects source, output, and toolchain changes', () => {
        const projectRoot = mkdtempSync(path.join(tmpdir(), 'evb-release-receipt-'));
        const inputPath = path.join(projectRoot, 'source.ts');
        const outputPath = path.join(projectRoot, 'dist', 'main.js');
        const receiptPath = path.join(projectRoot, '.devkit', 'receipt.json');
        mkdirSync(path.dirname(outputPath), {recursive: true});
        writeFileSync(inputPath, 'export const value = 1;\n');
        writeFileSync(outputPath, 'built-output\n');

        try {
            const options = {
                env: {NODE_ENV: 'production'},
                inputFiles: ['source.ts'],
                outputPaths: ['dist'],
                projectRoot,
                runCommand: fakeToolchain,
            };
            const original = writeReleaseBuildReceipt(receiptPath, options);
            expect(validateReleaseBuildReceipt(receiptPath, options)).toMatchObject({
                receipt: original,
                valid: true,
            });

            writeFileSync(inputPath, 'export const value = 2;\n');
            expect(validateReleaseBuildReceipt(receiptPath, options)).toEqual({
                reason: 'inputs-changed',
                valid: false,
            });
            writeFileSync(inputPath, 'export const value = 1;\n');
            writeFileSync(outputPath, 'tampered-output\n');
            expect(validateReleaseBuildReceipt(receiptPath, options)).toEqual({
                reason: 'outputs-changed',
                valid: false,
            });
            expect(validateReleaseBuildReceipt(receiptPath, {
                ...options,
                runCommand: (command: string, args: string[]) => (
                    `${command} ${args.join(' ')} different-version`
                ),
            })).toEqual({
                reason: 'inputs-changed',
                valid: false,
            });
        } finally {
            rmSync(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('fails closed when a required output is absent', () => {
        const projectRoot = mkdtempSync(path.join(tmpdir(), 'evb-release-receipt-missing-'));
        writeFileSync(path.join(projectRoot, 'source.ts'), 'source\n');
        try {
            expect(() => computeReleaseBuildState({
                inputFiles: ['source.ts'],
                outputPaths: ['missing-output'],
                projectRoot,
                runCommand: fakeToolchain,
            })).toThrow();
        } finally {
            rmSync(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
