import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

type TBuildStrictModule = { getPnpmCommand: (platform?: NodeJS.Platform) => string };

const { getPnpmCommand } = await import(
    pathToFileURL(path.join(process.cwd(), 'scripts/run-build-strict.mjs')).href
) as TBuildStrictModule;

describe('run-build-strict', () => {
    it('uses the Windows pnpm command shim for child processes', () => {
        expect(getPnpmCommand('win32')).toBe('pnpm.cmd');
    });

    it('uses pnpm directly on POSIX platforms', () => {
        expect(getPnpmCommand('darwin')).toBe('pnpm');
        expect(getPnpmCommand('linux')).toBe('pnpm');
    });
});
