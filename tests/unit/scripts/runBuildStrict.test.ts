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

type TBuildStrictModule = {
    getPnpmInvocation: (args: string[], platform?: NodeJS.Platform) => TPnpmInvocation;
    getStrictBuildEnv: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

const {
    getPnpmInvocation,
    getStrictBuildEnv,
} = await import(
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

    it('adds a heap floor for strict build child processes', () => {
        expect(getStrictBuildEnv({}).NODE_OPTIONS).toBe('--max-old-space-size=6144');
        expect(getStrictBuildEnv({ NODE_OPTIONS: '--trace-warnings' }).NODE_OPTIONS)
            .toBe('--trace-warnings --max-old-space-size=6144');
    });

    it('preserves an explicit heap setting from the caller', () => {
        expect(getStrictBuildEnv({ NODE_OPTIONS: '--max-old-space-size=8192 --trace-warnings' }).NODE_OPTIONS)
            .toBe('--max-old-space-size=8192 --trace-warnings');
    });
});
