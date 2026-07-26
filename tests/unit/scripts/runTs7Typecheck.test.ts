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
    it('runs the native TypeScript 7 alias while preserving TypeScript 6 for compiler API consumers', () => {
        const runnerOutput = execFileSync(process.execPath, [
            path.resolve(process.cwd(), 'scripts/run-ts7-typecheck.mjs'),
            '--version-check',
        ], {encoding: 'utf8'});

        expect(runnerOutput).toMatch(/Using TypeScript 7\.\d+\.\d+ native compiler/u);
        expect(readPackageVersion('typescript7')).toMatch(/^7\./u);

        // TypeScript 6 is the supported compiler-API bridge for vue-tsc/Volar,
        // typescript-eslint, and the local AST scripts while TypeScript 7 has no
        // stable API. Widen this only when those consumers can target TS7.
        expect(readPackageVersion('typescript')).toMatch(/^6\./u);
    });

    it('exposes the compiler API from the compatibility compiler but not the native alias', async () => {
        const compatibilityCompiler = await import('typescript');
        const nativeCompiler = await import('typescript7');

        expect(typeof compatibilityCompiler.default.createSourceFile).toBe('function');
        expect((nativeCompiler.default as Record<string, unknown>).createSourceFile).toBeUndefined();
    });
});
