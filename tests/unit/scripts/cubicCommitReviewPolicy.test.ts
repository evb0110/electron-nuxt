import {spawnSync} from 'node:child_process';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface ICubicReviewModule {
    cacheMarkerName: (commit: string, version: string) => string;
    classifyTerminalEvent: (event: unknown, exitCode?: number) => {
        issues?: unknown[];
        kind: 'advisory' | 'clean' | 'failed' | 'findings';
        message?: string;
    };
    cubicInvocation: (binary: string, arguments_: string[], options?: {
        env?: NodeJS.ProcessEnv;
        platform?: NodeJS.Platform;
    }) => {
        arguments: string[];
        command: string;
    };
    main: (arguments_?: string[], cwd?: string) => Promise<number>;
    resolveCubicBinary: (options?: {
        env?: NodeJS.ProcessEnv;
        homeDirectory?: string;
        platform?: NodeJS.Platform;
    }) => null | string;
    resolveReviewTimeout: (env?: NodeJS.ProcessEnv) => number;
}

const cubicReview = await import(
    pathToFileURL(path.resolve(process.cwd(), 'scripts/review-cubic-commits.mjs')).href
) as ICubicReviewModule;

function runGit(cwd: string, arguments_: string[]) {
    const result = spawnSync('git', arguments_, {
        cwd,
        encoding: 'utf8',
    });
    if (result.error || result.status !== 0) {
        throw result.error ?? new Error(result.stderr);
    }
}

async function withProcessEnv<T>(values: Record<string, string | undefined>, callback: () => Promise<T>) {
    const original = Object.fromEntries(
        Object.keys(values).map(key => [
            key,
            process.env[key],
        ]),
    );
    try {
        for (const [
            key,
            value,
        ] of Object.entries(values)) {
            if (value === undefined) {
                Reflect.deleteProperty(process.env, key);
            } else {
                process.env[key] = value;
            }
        }
        return await callback();
    } finally {
        for (const [
            key,
            value,
        ] of Object.entries(original)) {
            if (value === undefined) {
                Reflect.deleteProperty(process.env, key);
            } else {
                process.env[key] = value;
            }
        }
    }
}

describe('Cubic local commit review policy', () => {
    it('accepts only an explicit clean terminal event', () => {
        expect(cubicReview.classifyTerminalEvent({
            issues: [],
            outcome: 'clean',
            type: 'review.completed',
        })).toEqual({
            issues: [],
            kind: 'clean',
        });

        expect(cubicReview.classifyTerminalEvent({
            issues: [{priority: 'P1'}],
            outcome: 'issues',
            type: 'review.completed',
        })).toMatchObject({kind: 'findings'});

        expect(cubicReview.classifyTerminalEvent({
            issues: [{priority: 'P2'}],
            outcome: 'issues',
            type: 'review.completed',
        })).toMatchObject({kind: 'advisory'});

        expect(cubicReview.classifyTerminalEvent({
            issues: [
                {priority: 'P2'},
                {priority: 'P3'},
            ],
            outcome: 'issues',
            type: 'review.completed',
        })).toMatchObject({kind: 'advisory'});

        expect(cubicReview.classifyTerminalEvent({
            issues: [{title: 'Unclassified finding'}],
            outcome: 'issues',
            type: 'review.completed',
        })).toMatchObject({kind: 'findings'});
    });

    it('treats service and malformed-response failures as operational failures', () => {
        expect(cubicReview.classifyTerminalEvent({
            error: {message: 'No active subscription'},
            type: 'review.failed',
        }, 1)).toEqual({
            kind: 'failed',
            message: 'No active subscription',
        });

        expect(cubicReview.classifyTerminalEvent(null, 1)).toEqual({
            kind: 'failed',
            message: 'cubic exited with code 1 without a terminal review event',
        });
    });

    it('keeps passing-review cache entries version-specific and path-safe', () => {
        expect(cubicReview.cacheMarkerName('abc123', '1.10.5')).toBe('abc123-1.10.5.passed');
        expect(cubicReview.cacheMarkerName('abc123', 'next build/1')).toBe('abc123-next_build_1.passed');
    });

    it('keeps Cubic and scan-cleanup oracles out of the pre-push hook', async () => {
        const prePush = await readFile(path.join(process.cwd(), '.husky', 'pre-push'), 'utf8');

        expect(prePush).toContain('scripts/check-commit-attribution.mjs --pre-push');
        expect(prePush).not.toContain('review-cubic-commits.mjs');
        expect(prePush).not.toContain('scan-cleanup-oracles.sh');
    });

    it('enforces findings while failing open for Cubic availability errors and honoring cache force', async () => {
        const repository = await mkdtemp(path.join(tmpdir(), 'cubic-main-policy-'));
        try {
            runGit(repository, [
                'init',
                '--initial-branch=main',
                '.',
            ]);
            runGit(repository, [
                '-c',
                'user.name=Test User',
                '-c',
                'user.email=test@example.test',
                'commit',
                '--allow-empty',
                '-m',
                'Test commit',
            ]);

            const binary = path.join(repository, 'cubic-stub');
            const countPath = path.join(repository, 'review-count.log');
            await writeFile(binary, [
                '#!/bin/sh',
                'case "$1" in',
                '  --version)',
                '    [ "$CUBIC_STUB_MODE" = unknown-version ] && exit 1',
                '    [ "$CUBIC_STUB_MODE" = empty-version ] && exit 0',
                '    [ "$CUBIC_STUB_MODE" = advisory ] && printf \'1.10.6\\n\' && exit 0',
                '    printf \'1.10.5\\n\'',
                '    ;;',
                '  auth)',
                '    [ "$CUBIC_STUB_MODE" = unauthenticated ] && exit 1',
                '    printf \'1 credentials\\n\'',
                '    ;;',
                '  review)',
                '    printf \'review\\n\' >> "$CUBIC_STUB_COUNT"',
                '    case "$CUBIC_STUB_MODE" in',
                '      findings) printf \'%s\\n\' \'{"type":"review.completed","outcome":"issues","issues":[{"priority":"P1"}]}\' ;;',
                '      advisory) printf \'%s\\n\' \'{"type":"review.completed","outcome":"issues","issues":[{"priority":"P2"}]}\' ;;',
                '      failed) printf \'%s\\n\' \'{"type":"review.failed","error":{"message":"service unavailable"}}\'; exit 1 ;;',
                '      *) printf \'%s\\n\' \'{"type":"review.completed","outcome":"clean","issues":[]}\' ;;',
                '    esac',
                '    ;;',
                'esac',
                '',
            ].join('\n'), {mode: 0o755});

            const runMain = (mode: string, extraEnv: Record<string, string | undefined> = {}) => (
                withProcessEnv({
                    CUBIC_BIN: binary,
                    CUBIC_REVIEW_FORCE: undefined,
                    CUBIC_STUB_COUNT: countPath,
                    CUBIC_STUB_MODE: mode,
                    ...extraEnv,
                }, () => cubicReview.main([
                    '--commit',
                    'HEAD',
                ], repository))
            );

            expect(await runMain('findings')).toBe(1);
            expect(await runMain('advisory')).toBe(0);
            expect(await runMain('failed')).toBe(0);
            expect(await runMain('unauthenticated')).toBe(0);
            expect(await withProcessEnv({CUBIC_BIN: path.join(repository, 'missing')}, () => (
                cubicReview.main([
                    '--commit',
                    'HEAD',
                ], repository)
            ))).toBe(0);

            await writeFile(countPath, '', 'utf8');
            expect(await runMain('clean')).toBe(0);
            expect(await runMain('clean')).toBe(0);
            expect((await readFile(countPath, 'utf8')).trim().split('\n')).toHaveLength(1);
            expect(await runMain('clean', {CUBIC_REVIEW_FORCE: '1'})).toBe(0);
            expect((await readFile(countPath, 'utf8')).trim().split('\n')).toHaveLength(2);

            await writeFile(countPath, '', 'utf8');
            expect(await runMain('unknown-version')).toBe(0);
            expect(await runMain('unknown-version')).toBe(0);
            expect((await readFile(countPath, 'utf8')).trim().split('\n')).toHaveLength(2);

            await writeFile(countPath, '', 'utf8');
            expect(await runMain('empty-version')).toBe(0);
            expect(await runMain('empty-version')).toBe(0);
            expect((await readFile(countPath, 'utf8')).trim().split('\n')).toHaveLength(2);
        } finally {
            await rm(repository, {
                force: true,
                recursive: true,
            });
        }
    });

    it('fails closed for invalid arguments and unresolved commits even when Cubic is unavailable', async () => {
        const repository = await mkdtemp(path.join(tmpdir(), 'cubic-local-errors-'));
        try {
            runGit(repository, [
                'init',
                '--initial-branch=main',
                '.',
            ]);
            runGit(repository, [
                '-c',
                'user.name=Test User',
                '-c',
                'user.email=test@example.test',
                'commit',
                '--allow-empty',
                '-m',
                'Test commit',
            ]);

            await withProcessEnv({CUBIC_BIN: path.join(repository, 'missing')}, async () => {
                await expect(cubicReview.main(['--unknown'], repository))
                    .rejects.toThrow('Unknown argument');
                await expect(cubicReview.main([
                    '--commit',
                    'missing-commit',
                ], repository)).rejects.toThrow('git rev-parse --verify');
            });
        } finally {
            await rm(repository, {
                force: true,
                recursive: true,
            });
        }
    });

    it('resolves the standard per-user installation when PATH has no cubic', async () => {
        const homeDirectory = await mkdtemp(path.join(tmpdir(), 'cubic-review-home-'));
        try {
            const binary = path.join(homeDirectory, '.cubic', 'bin', 'cubic');
            await mkdir(path.dirname(binary), {recursive: true});
            await writeFile(binary, '#!/bin/sh\n', {
                encoding: 'utf8',
                mode: 0o755,
            });

            expect(cubicReview.resolveCubicBinary({
                env: {PATH: ''},
                homeDirectory,
            })).toBe(binary);
        } finally {
            await rm(homeDirectory, {
                force: true,
                recursive: true,
            });
        }
    });

    it('discovers and safely invokes the Windows npm command shim', async () => {
        const homeDirectory = await mkdtemp(path.join(tmpdir(), 'cubic-review-windows-'));
        try {
            const binDirectory = path.join(homeDirectory, 'npm-bin');
            const binary = path.join(binDirectory, 'cubic.cmd');
            await mkdir(binDirectory, {recursive: true});
            await writeFile(binary, '@echo off\r\n', {
                encoding: 'utf8',
                mode: 0o755,
            });

            expect(cubicReview.resolveCubicBinary({
                env: {PATH: binDirectory},
                homeDirectory,
                platform: 'win32',
            })).toBe(binary);
            expect(cubicReview.cubicInvocation(binary, [
                'review',
                '--commit',
                'abc123',
            ], {
                env: {ComSpec: 'C:\\Windows\\System32\\cmd.exe'},
                platform: 'win32',
            })).toEqual({
                arguments: [
                    '/d',
                    '/s',
                    '/c',
                    `"${binary}" "review" "--commit" "abc123"`,
                ],
                command: 'C:\\Windows\\System32\\cmd.exe',
            });
            expect(() => cubicReview.cubicInvocation(binary, ['unsafe&argument'], {platform: 'win32'}))
                .toThrow('unsupported shell metacharacters');
        } finally {
            await rm(homeDirectory, {
                force: true,
                recursive: true,
            });
        }
    });
});
