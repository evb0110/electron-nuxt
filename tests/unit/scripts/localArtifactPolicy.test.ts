import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface ILocalArtifactPolicyModule {
    AGENT_INSTRUCTION_FILE_NAMES: string[];
    LOCAL_ONLY_DIRECTORY_NAMES: string[];
    REQUIRED_GITIGNORE_PATTERNS: string[];
    describeForbiddenArtifactPath: (filePath: string) => string | null;
    findMissingGitIgnorePatterns: (content: string) => string[];
}

interface IWebDeploySourceModule {
    REQUIRED_VERCELIGNORE_ENTRIES: string[];
    WEB_DEPLOY_SOURCE_EXCLUDED_DIRECTORY_NAMES: string[];
    WEB_DEPLOY_SOURCE_EXCLUDED_FILE_NAMES: string[];
}

async function importScript<T>(relativePath: string) {
    return await import(
        pathToFileURL(path.resolve(process.cwd(), relativePath)).href
    ) as T;
}

const policy = await importScript<ILocalArtifactPolicyModule>('scripts/lib/local-artifact-policy.mjs');
const webDeploy = await importScript<IWebDeploySourceModule>('scripts/check-web-deploy-source.mjs');

describe('local artifact policy', () => {
    it('covers the local-only conventions this project actually encounters', () => {
        expect(policy.AGENT_INSTRUCTION_FILE_NAMES).toEqual([
            'AGENTS.md',
            'CLAUDE.md',
            'GEMINI.md',
        ]);
        expect(policy.LOCAL_ONLY_DIRECTORY_NAMES).toEqual([
            '.agents',
            '.claude',
            '.codex',
            '.devkit',
        ]);
    });

    it.each([
        [
            'AGENTS.md',
            'agent instruction file AGENTS.md',
        ],
        [
            'landing/CLAUDE.md',
            'agent instruction file CLAUDE.md',
        ],
        [
            'packages/contracts/agents.md',
            'agent instruction file AGENTS.md',
        ],
        [
            'AGENTS.MD',
            'agent instruction file AGENTS.md',
        ],
        [
            'Claude.Md',
            'agent instruction file CLAUDE.md',
        ],
        [
            'tools/harness/cLaUdE.MD',
            'agent instruction file CLAUDE.md',
        ],
        [
            'packages/contracts/gemini.md',
            'agent instruction file GEMINI.md',
        ],
        [
            '.agents/rules/review.md',
            'agent harness directory .agents/',
        ],
        [
            'tools/.claude/settings.json',
            'agent harness directory .claude/',
        ],
        [
            '.codex/config.toml',
            'agent harness directory .codex/',
        ],
        [
            '.devkit/plans/perf-lowend/run/ledger.md',
            'local working directory .devkit/',
        ],
        [
            'tools/.devkit/notes.md',
            'local working directory .devkit/',
        ],
    ])('rejects %s', (filePath, expectedReason) => {
        expect(policy.describeForbiddenArtifactPath(filePath)).toContain(expectedReason);
    });

    it.each([
        'electron/features/agent/agentSession.ts',
        'docs/agents-overview.md',
        'docs/agents/overview.md',
        'packages/contracts/claudeAgentSdk.ts',
        'AGENTS.mdx',
        'agents.markdown',
        'MEMORIES.md',
        'CODEX.md',
        'AGENTS-v2.md',
        'my-agents.md',
        'docs/AGENTS.md.bak',
        'docs/devkit-notes.md',
        'scripts/devkit/report.mjs',
        'devkit/plans/notes.md',
    ])('keeps product path %s legal', (filePath) => {
        expect(policy.describeForbiddenArtifactPath(filePath)).toBeNull();
    });

    it('ignores every forbidden artifact at any depth', async () => {
        const gitIgnore = await readFile(path.join(process.cwd(), '.gitignore'), 'utf8');

        expect(policy.findMissingGitIgnorePatterns(gitIgnore)).toEqual([]);
        // A leading slash would anchor the rule to the repository root and leave
        // `landing/CLAUDE.md` trackable.
        expect(policy.REQUIRED_GITIGNORE_PATTERNS.some(pattern => pattern.startsWith('/'))).toBe(false);
    });

    it('reports missing and anchored-only patterns as missing coverage', () => {
        expect(policy.findMissingGitIgnorePatterns(`${policy.REQUIRED_GITIGNORE_PATTERNS.join('\n')}\n`))
            .toEqual([]);
        // A leading slash anchors the rule to the repository root, so the
        // artifact stays trackable in every subdirectory.
        expect(policy.findMissingGitIgnorePatterns('/AGENTS.md\n/CLAUDE.md\n'))
            .toEqual(policy.REQUIRED_GITIGNORE_PATTERNS);
    });

    it('derives the web deploy exclusions from the same policy', () => {
        for (const directoryName of policy.LOCAL_ONLY_DIRECTORY_NAMES) {
            expect(webDeploy.WEB_DEPLOY_SOURCE_EXCLUDED_DIRECTORY_NAMES).toContain(directoryName);
            expect(webDeploy.REQUIRED_VERCELIGNORE_ENTRIES).toContain(`${directoryName}/`);
        }
        for (const fileName of policy.AGENT_INSTRUCTION_FILE_NAMES) {
            expect(webDeploy.WEB_DEPLOY_SOURCE_EXCLUDED_FILE_NAMES).toContain(fileName);
            expect(webDeploy.REQUIRED_VERCELIGNORE_ENTRIES).toContain(fileName);
        }
    });
});
