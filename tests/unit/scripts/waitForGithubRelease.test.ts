import {
    describe,
    expect,
    it,
} from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const {
    isTransientGitHubCliError,
    waitForRelease,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/release/wait-for-github-release.mjs')).href,
);

describe('wait-for-github-release', () => {
    it('retries transient GitHub CLI polling failures until the release workflow succeeds', async () => {
        const stderr: string[] = [];
        const stdout: string[] = [];
        let attempts = 0;
        let now = 0;

        await waitForRelease('v0.1.317', {
            findReleaseRunFn: () => {
                attempts += 1;
                if (attempts === 1) {
                    throw new Error(
                        'couldn\'t fetch workflows: Get "https://api.github.com/repos/example/actions/workflows": net/http: TLS handshake timeout',
                    );
                }

                return {
                    conclusion: 'success',
                    databaseId: 123,
                    status: 'completed',
                    url: 'https://github.com/example/repo/actions/runs/123',
                };
            },
            nowFn: () => now,
            readWaitTimeoutMsFn: () => 60_000,
            sleepFn: async (duration: number) => {
                now += duration;
            },
            stderr: { write: (message: string) => stderr.push(message) },
            stdout: { write: (message: string) => stdout.push(message) },
        });

        expect(attempts).toBe(2);
        expect(stderr.join('')).toContain('Transient GitHub polling failure');
        expect(stdout.join('')).toContain('Release workflow succeeded for v0.1.317');
    });

    it('does not classify authentication failures as transient polling errors', () => {
        expect(isTransientGitHubCliError(
            new Error('HTTP 401: Requires authentication'),
        )).toBe(false);
    });

    it('passes the requested target sha and dispatch timestamp to the run matcher', async () => {
        const matcherArgs: unknown[][] = [];

        await waitForRelease('v0.1.400', {
            createdAfter: '2026-06-21T10:00:00.000Z',
            findReleaseRunFn: (...args: unknown[]) => {
                matcherArgs.push(args);
                return {
                    conclusion: 'success',
                    databaseId: 456,
                    status: 'completed',
                    url: 'https://github.com/example/repo/actions/runs/456',
                };
            },
            readWaitTimeoutMsFn: () => 60_000,
            sleepFn: async () => {},
            stdout: { write: () => undefined },
            targetSha: 'abc123',
        });

        expect(matcherArgs).toEqual([[
            'v0.1.400',
            'abc123',
            '2026-06-21T10:00:00.000Z',
        ]]);
    });
});
