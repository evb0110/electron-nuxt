import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    assertReleaseCutPreconditions,
    cutRelease,
    parseCutReleaseArgs,
    resumeRelease,
} from '@scripts/release/cut-release.mjs';
import {runReleasePreflight} from '@scripts/release/release-cut-preflight.mjs';

const HEAD_SHA = 'a'.repeat(40);
const PARENT_SHA = 'b'.repeat(40);
const UPSTREAM = {
    branch: 'main',
    ref: 'origin/main',
    remote: 'origin',
};

function createPreconditionOptions(overrides: Record<string, unknown> = {}) {
    const events: string[] = [];

    return {
        assertCleanWorktreeFn: () => events.push('clean'),
        assertCurrentReleaseIsNotDraftFn: (tag: string) => events.push(`draft:${tag}`),
        assertGitHubCliReadyFn: () => events.push('github'),
        assertMainTipFn: () => {
            events.push('tip');
            return {
                headSha: HEAD_SHA,
                upstreamSha: HEAD_SHA,
            };
        },
        assertNodeBaselineFn: () => events.push('node'),
        assertTagAbsentFn: (tag: string) => events.push(`tag:${tag}`),
        events,
        findCiRunFn: () => ({
            conclusion: 'success',
            html_url: 'https://github.com/example/ci/runs/10',
            status: 'completed',
        }),
        getUpstreamFn: () => UPSTREAM,
        level: 'patch',
        readVersionFn: () => '0.1.445',
        runCommand: () => '',
        waitForCiFn: (sha: string) => events.push(`wait:${sha}`),
        ...overrides,
    };
}

describe('cut-release', () => {
    it('accepts a release level without the rejected separator form', () => {
        expect(parseCutReleaseArgs(['patch'])).toEqual({
            level: 'patch',
            resume: false,
        });
        expect(parseCutReleaseArgs(['minor'])).toEqual({
            level: 'minor',
            resume: false,
        });
    });

    it('removes the old local verification flag', () => {
        expect(() => parseCutReleaseArgs([
            '--full-verify',
            'patch',
        ])).toThrow(/Unknown release option/u);
    });

    it('checks the fetched main tip, CI, current release, and next tag before bumping', async () => {
        const options = createPreconditionOptions();
        const result = await assertReleaseCutPreconditions(options);

        expect(result).toEqual({
            currentVersion: '0.1.445',
            headSha: HEAD_SHA,
            nextVersion: '0.1.446',
            upstream: UPSTREAM,
        });
        expect(options.events).toEqual([
            'node',
            'github',
            'clean',
            'tip',
            `wait:${HEAD_SHA}`,
            'draft:v0.1.445',
            'tag:v0.1.446',
        ]);
    });

    it('waits for the push run when HEAD has none yet', async () => {
        const options = createPreconditionOptions({findCiRunFn: () => null});

        await assertReleaseCutPreconditions(options);

        expect(options.events).toContain(`wait:${HEAD_SHA}`);
    });

    it('refuses a failed HEAD CI run with its URL', async () => {
        const options = createPreconditionOptions({findCiRunFn: () => ({
            conclusion: 'failure',
            html_url: 'https://github.com/example/ci/runs/99',
            status: 'completed',
        })});

        await expect(assertReleaseCutPreconditions(options))
            .rejects.toThrow(/https:\/\/github\.com\/example\/ci\/runs\/99/u);
    });

    it('commits only the bumped package version with skip-ci attribution', async () => {
        let version = '0.1.445';
        const commands: string[] = [];
        const stagedFiles: string[][] = [];
        const changedFileAssertions: unknown[] = [];
        let published: unknown;
        const options = createPreconditionOptions({
            assertChangedFilesMatchFn: (...args: unknown[]) => changedFileAssertions.push(args),
            readVersionFn: () => version,
            runCommand: (command: string, args: string[]) => {
                commands.push(`${command} ${args.join(' ')}`);
                return '';
            },
            stageFilesFn: (files: string[]) => stagedFiles.push(files),
            writeVersionFn: (nextVersion: string) => {
                version = nextVersion;
            },
            publishReleaseCommitFn: async (request: unknown) => {
                published = request;
            },
        });

        await cutRelease('patch', options);

        expect(version).toBe('0.1.446');
        expect(stagedFiles).toEqual([['package.json']]);
        expect(changedFileAssertions).toHaveLength(1);
        expect(commands).toContain(
            'git commit -m release: 0.1.446 [skip ci] -- package.json',
        );
        expect(commands.some(command => command.includes('release:verify'))).toBe(false);
        expect(published).toEqual({
            tag: 'v0.1.446',
            upstream: UPSTREAM,
        });
    });

    it('repairs a draft by deleting it and redispatching the current release SHA', async () => {
        const commands: string[] = [];
        let publishedOptions: Record<string, unknown> | undefined;
        let publishedRequest: Record<string, unknown> | undefined;
        const options = {
            assertCleanWorktreeFn: () => undefined,
            assertGitHubCliReadyFn: () => undefined,
            assertNodeBaselineFn: () => undefined,
            fetchReleaseMainFn: () => undefined,
            getUpstreamFn: () => UPSTREAM,
            readReleaseFn: () => ({isDraft: true}),
            readVersionFn: () => '0.1.446',
            runCommand: (command: string, args: string[]) => {
                commands.push(`${command} ${args.join(' ')}`);
                if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
                    return HEAD_SHA;
                }
                if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
                    return PARENT_SHA;
                }
                if (command === 'git' && args[0] === 'diff' && args[1] === '--numstat') {
                    return '1\t1\tpackage.json';
                }
                if (command === 'git' && args[0] === 'diff' && args[1] === '-U0') {
                    return '-  "version": "0.1.445",\n+  "version": "0.1.446",';
                }
                if (command === 'git' && args[0] === 'log') {
                    return 'release: 0.1.446 [skip ci]';
                }
                return '';
            },
            publishReleaseCommitFn: async (
                request: Record<string, unknown>,
                publishOptions: Record<string, unknown>,
            ) => {
                publishedRequest = request;
                publishedOptions = publishOptions;
            },
        };

        await resumeRelease(options);

        expect(commands).toContain('gh release delete v0.1.446 --yes');
        expect(publishedRequest).toEqual({
            tag: 'v0.1.446',
            targetSha: HEAD_SHA,
            upstream: UPSTREAM,
        });
        expect(publishedOptions?.push).toBe(false);
    });

    it('refuses to resume a public release', async () => {
        const options = {
            assertCleanWorktreeFn: () => undefined,
            assertGitHubCliReadyFn: () => undefined,
            assertNodeBaselineFn: () => undefined,
            fetchReleaseMainFn: () => undefined,
            getUpstreamFn: () => UPSTREAM,
            readReleaseFn: () => ({isDraft: false}),
            readVersionFn: () => '0.1.446',
            runCommand: (command: string, args: string[]) => {
                if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
                    return HEAD_SHA;
                }
                if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
                    return PARENT_SHA;
                }
                if (command === 'git' && args[0] === 'diff' && args[1] === '--numstat') {
                    return '1\t1\tpackage.json';
                }
                if (command === 'git' && args[0] === 'diff' && args[1] === '-U0') {
                    return '-  "version": "0.1.445",\n+  "version": "0.1.446",';
                }
                if (command === 'git' && args[0] === 'log') {
                    return 'release: 0.1.446 [skip ci]';
                }
                return '';
            },
        };

        await expect(resumeRelease(options)).rejects.toThrow(/already public.*release:status/u);
    });
});

describe('runReleasePreflight', () => {
    it('runs the patch preconditions and reports the version step', async () => {
        const calls: unknown[] = [];
        const output: string[] = [];

        const result = await runReleasePreflight({
            assertPreconditions: async (options: unknown) => {
                calls.push(options);
                return {
                    currentVersion: '1.2.3',
                    headSha: HEAD_SHA,
                    nextVersion: '1.2.4',
                    upstream: UPSTREAM,
                };
            },
            write: (message: string) => {
                output.push(message);
            },
        });

        expect(calls).toEqual([{
            context: 'Release preflight',
            level: 'patch',
        }]);
        expect(output).toEqual(['Release patch preflight passed: 1.2.3 -> 1.2.4 on origin/main.\n']);
        expect(result.nextVersion).toBe('1.2.4');
    });
});
