// Canonical policy for local-only artifacts: files that exist on a developer
// machine to configure a coding assistant or to hold local working material.
// None of them is part of the product, so they must stay untracked, unpublished,
// and out of the web deploy source.
//
// The enforcing gates import this list directly: the staged, pre-push, and CI
// history checks in `check-commit-attribution.mjs`, and the web deploy source
// filter in `check-web-deploy-source.mjs`. `.gitignore` and `.vercelignore` are
// static text that cannot import anything, so they restate the list and a unit
// test asserts each one still mirrors what is declared here.
//
// The list is deliberately limited to names real tooling reads. Names that
// merely sound related (`docs/agents-overview.md`, `docs/devkit-notes.md`,
// `electron/features/agent/…`) are ordinary product paths and stay legal.

export const AGENT_INSTRUCTION_FILE_NAMES = [
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
];

// `.devkit/` holds local planning and run material. It is ignored working state,
// never product source, so a forced `git add` under it must fail exactly as a
// harness directory does.
const LOCAL_ONLY_DIRECTORIES = [
    {
        kind: 'agent harness directory',
        name: '.agents',
    },
    {
        kind: 'agent harness directory',
        name: '.claude',
    },
    {
        kind: 'agent harness directory',
        name: '.codex',
    },
    {
        kind: 'local working directory',
        name: '.devkit',
    },
];

export const LOCAL_ONLY_DIRECTORY_NAMES = LOCAL_ONLY_DIRECTORIES.map(({name}) => name);

// Harnesses read the canonical upper-case name, but contributors and editors
// write `agents.md`, `Claude.Md`, or `AGENTS.MD` just as readily, and a
// case-insensitive checkout resolves all of them to the same file. Compare the
// whole basename case-insensitively; only ASCII case folds, so a name such as
// `AGENTS.MD` matches while `AGENTS.mdx` or `MEMORIES.md` stays an ordinary
// document.
//
// Directory names are compared exactly: the tooling that creates `.claude` and
// `.devkit` always spells them in lower case.
function asciiLowerCase(value) {
    return value.replace(/[A-Z]/gu, character => character.toLowerCase());
}

/**
 * Returns the canonical instruction file name a basename spells in any ASCII
 * case, or null for an ordinary file name.
 *
 * @param {string} fileName basename, with no directory part
 * @returns {string | null}
 */
export function findAgentInstructionFileName(fileName) {
    const normalized = asciiLowerCase(fileName);
    return AGENT_INSTRUCTION_FILE_NAMES
        .find(candidate => asciiLowerCase(candidate) === normalized) ?? null;
}

/**
 * Describes why a repository-relative path is a forbidden local-only artifact,
 * or returns null when the path is ordinary product content.
 *
 * @param {string} filePath repository-relative, `/`-separated path
 * @returns {string | null}
 */
export function describeForbiddenArtifactPath(filePath) {
    const segments = filePath.split('/').filter(Boolean);
    if (segments.length === 0) {
        return null;
    }

    const instructionFileName = findAgentInstructionFileName(segments.at(-1));
    if (instructionFileName) {
        return `agent instruction file ${instructionFileName} at ${filePath}`;
    }

    const directorySegments = segments.slice(0, -1);
    const directory = LOCAL_ONLY_DIRECTORIES
        .find(({name}) => directorySegments.includes(name));

    return directory ? `${directory.kind} ${directory.name}/ at ${filePath}` : null;
}

// A bare name ignores the artifact at any depth; a trailing slash ignores the
// directory and everything under it.
export const REQUIRED_GITIGNORE_PATTERNS = [
    ...AGENT_INSTRUCTION_FILE_NAMES,
    ...LOCAL_ONLY_DIRECTORY_NAMES.map(name => `${name}/`),
];

/**
 * Returns the required ignore patterns `.gitignore` does not declare. An anchored
 * form such as `/AGENTS.md` does not count: it leaves the artifact trackable in
 * every subdirectory.
 *
 * This is a literal line comparison, not a gitignore engine. The ignore file is
 * developer convenience — a missing or anchored entry is the mistake worth
 * catching. Case variants, negations, and every other way of re-including a file
 * are the job of the deterministic staged and pre-push checks, which see what is
 * actually about to be committed or pushed.
 *
 * @param {string} content `.gitignore` contents
 * @returns {string[]}
 */
export function findMissingGitIgnorePatterns(content) {
    const lines = content
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));

    return REQUIRED_GITIGNORE_PATTERNS.filter(pattern => !lines.includes(pattern));
}
