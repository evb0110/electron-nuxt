import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

type TPnpmInvocation = {
    args: string[];
    command: string;
};

type TBuildStrictModule = { getPnpmInvocation: (args: string[], platform?: NodeJS.Platform) => TPnpmInvocation };

const { getPnpmInvocation } = await import(
    pathToFileURL(path.join(process.cwd(), 'scripts/run-build-strict.mjs')).href
) as TBuildStrictModule;

describe('run-build-strict', () => {
    it('uses cmd.exe for Windows pnpm child processes', () => {
        expect(getPnpmInvocation([
            'run',
            'build:desktop',
        ], 'win32')).toEqual({
            args: [
                '/d',
                '/s',
                '/c',
                'pnpm',
                'run',
                'build:desktop',
            ],
            command: 'cmd.exe',
        });
    });

    it('uses pnpm directly on POSIX platforms', () => {
        const args = [
            'run',
            'build:desktop',
        ];

        expect(getPnpmInvocation(args, 'darwin')).toEqual({
            args,
            command: 'pnpm',
        });
        expect(getPnpmInvocation(args, 'linux')).toEqual({
            args,
            command: 'pnpm',
        });
    });
});
