import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface IPackageVersion { version: string }

const require = createRequire(import.meta.url);

function readPackageVersion(packageName: string) {
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    return (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as IPackageVersion).version;
}

describe('TypeScript compiler separation', () => {
    it('runs the native TypeScript 7 alias while preserving TypeScript 5 for compiler API consumers', () => {
        const runnerOutput = execFileSync(process.execPath, [
            path.resolve(process.cwd(), 'scripts/run-ts7-typecheck.mjs'),
            '--version-check',
        ], {encoding: 'utf8'});

        expect(runnerOutput).toMatch(/Using TypeScript 7\.\d+\.\d+ native compiler/u);
        expect(readPackageVersion('typescript7')).toMatch(/^7\./u);
        expect(readPackageVersion('typescript')).toMatch(/^5\./u);
    });
});
