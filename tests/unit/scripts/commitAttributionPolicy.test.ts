import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path, {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface ICommitAttributionModule {
    collectPrePushCommits: (
        input: string,
        remoteName: string,
        cwd?: string,
    ) => string[];
    findCommitViolations: (
        commits: string[],
        cwd?: string,
    ) => Array<{
        commit: string;
        matches: string[];
    }>;
    findForbiddenAttribution: (text: string) => string[];
    main: (arguments_?: string[], cwd?: string) => void;
    parsePrePushUpdates: (input: string) => Array<{
        localOid: string;
        localRef: string;
        remoteOid: string;
        remoteRef: string;
    }>;
}

const checker = await import(
    pathToFileURL(path.resolve(process.cwd(), 'scripts/check-commit-attribution.mjs')).href
) as ICommitAttributionModule;

describe('commit attribution policy', () => {
    it.each([
        [
            'Co-Authored-By: Claude <contributor@example.test>',
            'Claude co-author trailer',
        ],
        [
            'Co-authored-by: Person <noreply@anthropic.com>',
            'Anthropic no-reply identity',
        ],
        [
            'Generated with Claude Code',
            'Claude generated-by marker',
        ],
        [
            'Generated with [Claude Code](https://example.test)',
            'Claude generated-by marker',
        ],
        [
            'Claude-Session: abc123',
            'Claude session trailer',
        ],
    ])('blocks %s', (message, expectedRule) => {
        expect(checker.findForbiddenAttribution(message)).toContain(expectedRule);
    });

    it('allows ordinary references to Claude and unrelated co-authors', () => {
        expect(checker.findForbiddenAttribution(
            'Document how Claude integrations are configured\n\n'
            + 'Co-Authored-By: Claudia Example <claudia@example.test>',
        )).toEqual([]);
    });

    it('validates commit message files before a commit is created', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-attribution-message-'));
        const messageFile = join(directory, 'COMMIT_EDITMSG');
        await writeFile(messageFile, 'Generated with Claude Code\n');

        const originalExitCode = process.exitCode;
        process.exitCode = undefined;
        checker.main([
            '--message-file',
            messageFile,
        ]);
        expect(process.exitCode).toBe(1);
        process.exitCode = originalExitCode;
    });

    it('parses all refs supplied by Git pre-push', () => {
        expect(checker.parsePrePushUpdates([
            'refs/heads/one aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa '
                + 'refs/heads/one bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            'refs/heads/two cccccccccccccccccccccccccccccccccccccccc '
                + 'refs/heads/two 0000000000000000000000000000000000000000',
        ].join('\n'))).toHaveLength(2);
    });

    it('checks every commit introduced by a push range, not only the tip', async () => {
        const repository = await mkdtemp(join(tmpdir(), 'evb-attribution-repo-'));
        try {
            runGit(repository, ['init']);
            runGit(repository, [
                'config',
                'user.name',
                'Test User',
            ]);
            runGit(repository, [
                'config',
                'user.email',
                'test@example.test',
            ]);
            runGit(repository, [
                'commit',
                '--allow-empty',
                '-m',
                'Clean base',
            ]);
            const base = runGit(repository, [
                'rev-parse',
                'HEAD',
            ]);
            runGit(repository, [
                'commit',
                '--allow-empty',
                '-m',
                'Generated with Claude Code',
            ]);
            const prohibitedCommit = runGit(repository, [
                'rev-parse',
                'HEAD',
            ]);
            runGit(repository, [
                'commit',
                '--allow-empty',
                '-m',
                'Clean tip',
            ]);
            const head = runGit(repository, [
                'rev-parse',
                'HEAD',
            ]);

            const commits = checker.collectPrePushCommits(
                `refs/heads/main ${head} refs/heads/main ${base}\n`,
                'origin',
                repository,
            );

            expect(commits).toHaveLength(2);
            expect(checker.findCommitViolations(commits, repository)).toEqual([{
                commit: prohibitedCommit,
                matches: ['Claude generated-by marker'],
            }]);
        } finally {
            await rm(repository, {
                force: true,
                recursive: true,
            });
        }
    });
});

function runGit(cwd: string, arguments_: string[]) {
    const result = spawnSync('git', arguments_, {
        cwd,
        encoding: 'utf8',
    });
    if (result.status !== 0) {
        throw new Error(result.stderr);
    }
    return result.stdout.trim();
}
