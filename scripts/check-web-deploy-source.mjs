import {
    lstat,
    readdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    AGENT_INSTRUCTION_FILE_NAMES,
    findAgentInstructionFileName,
    findRootOnlyLocalArtifactFileName,
    LOCAL_ONLY_DIRECTORY_NAMES,
    normalizeRepositoryRelativePath,
    ROOT_ONLY_LOCAL_ARTIFACT_FILE_NAMES,
} from './lib/local-artifact-policy.mjs';

const defaultProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MAX_WEB_DEPLOY_SOURCE_FILES = 14_000;
export const MAX_WEB_DEPLOY_SOURCE_BYTES = 128 * 1024 * 1024;

// The local-only artifact names — the harness directories, `.devkit/`, and the
// instruction file names — come from the canonical policy, so the deploy filter,
// the ignore rules, and the push checks cannot drift apart. The rest of this list
// is deploy-specific.
export const WEB_DEPLOY_SOURCE_EXCLUDED_DIRECTORY_NAMES = [
    ...LOCAL_ONLY_DIRECTORY_NAMES,
    '.angular',
    '.cache',
    '.fallow',
    '.git',
    '.github',
    '.husky',
    '.idea',
    '.next',
    '.nuxt',
    '.output',
    '.parcel-cache',
    '.playwright-cli',
    '.pnpm-store',
    '.playwright-mcp',
    '.svelte-kit',
    '.tmp',
    'tmp',
    '.turbo',
    '.vercel',
    '.vite',
    '.vscode',
    'build',
    'coverage',
    'dist',
    'dist-electron',
    'docs',
    'electron',
    'landing',
    'native',
    'node_modules',
    'nuxt-output',
    'release',
    'resources',
    'tests',
];

// `MEMORIES.md` is the local scratch note `.gitignore` describes: not part of the
// canonical artifact policy, so nothing rejects it from history, but it is never
// product content and must not reach the sanitized deploy source. Matched by exact
// basename, so `MEMORIES.mdx` and `memories.md` stay ordinary documents.
export const WEB_DEPLOY_SOURCE_EXCLUDED_FILE_NAMES = [
    ...AGENT_INSTRUCTION_FILE_NAMES,
    '.DS_Store',
    'MEMORIES.md',
    'electron-builder.yml',
    'eslint-plugin-custom.mjs',
];

export const WEB_DEPLOY_SOURCE_ROOT_ONLY_FILE_NAMES = [...ROOT_ONLY_LOCAL_ARTIFACT_FILE_NAMES];

export const REQUIRED_VERCELIGNORE_ENTRIES = [
    ...WEB_DEPLOY_SOURCE_EXCLUDED_DIRECTORY_NAMES.map(name => `${name}/`),
    ...WEB_DEPLOY_SOURCE_EXCLUDED_FILE_NAMES,
    ...WEB_DEPLOY_SOURCE_ROOT_ONLY_FILE_NAMES.map(name => `**/${name}`),
    '*.log',
];

function isExcludedEnvFileName(fileName) {
    if (fileName === '.env' || fileName.startsWith('.env.')) {
        return !/\.(example|sample|template)$/i.test(fileName);
    }

    return false;
}

function normalizeEntry(entry) {
    const trimmedEntry = entry.trim();

    if (!trimmedEntry || trimmedEntry.startsWith('#') || trimmedEntry.startsWith('!')) {
        return null;
    }

    return trimmedEntry.replace(/^\/+/, '');
}

export function parseVercelIgnoreEntries(content) {
    return new Set(
        content
            .split(/\r?\n/u)
            .map(normalizeEntry)
            .filter(entry => entry !== null),
    );
}

export function validateVercelIgnoreEntries(content, requiredEntries = REQUIRED_VERCELIGNORE_ENTRIES) {
    const entries = parseVercelIgnoreEntries(content);
    const missingEntries = requiredEntries.filter(entry => !entries.has(entry));

    if (missingEntries.length > 0) {
        throw new Error(`.vercelignore is missing web deploy exclusions: ${missingEntries.join(', ')}`);
    }

    return {
        entries,
        requiredEntries,
    };
}

/**
 * Directory names excluded from the deploy source at any depth. Compared exactly:
 * the tooling that creates these directories always spells them in lower case.
 */
export function isExcludedWebDeploySourceDirectoryName(directoryName) {
    return WEB_DEPLOY_SOURCE_EXCLUDED_DIRECTORY_NAMES.includes(directoryName);
}

/**
 * File basenames excluded from the deploy source at any depth.
 *
 * Instruction files reuse the canonical policy's predicate, so `AGENTS.MD` and
 * `Claude.Md` are skipped exactly as the commit and push checks reject them. The
 * other listed names are literal build-time files and the local scratch note,
 * each of which only ever has one spelling, and env files carry real secrets
 * unless they are an example template.
 */
export function isExcludedWebDeploySourceFileName(fileName) {
    return findAgentInstructionFileName(fileName) !== null
        || WEB_DEPLOY_SOURCE_EXCLUDED_FILE_NAMES.includes(fileName)
        || isExcludedEnvFileName(fileName);
}

export function isExcludedWebDeploySourcePath(fileName, relativeDirectory = '') {
    if (findRootOnlyLocalArtifactFileName(fileName)) {
        const normalizedDirectory = normalizeRepositoryRelativePath(relativeDirectory);
        return normalizedDirectory[0] !== 'docs';
    }
    return isExcludedWebDeploySourceFileName(fileName);
}

function shouldSkipSourcePath(dirent, relativeDirectory) {
    if (dirent.isDirectory()) {
        return isExcludedWebDeploySourceDirectoryName(dirent.name);
    }

    return isExcludedWebDeploySourcePath(dirent.name, relativeDirectory);
}

export async function collectWebDeploySourceStats({projectRoot = defaultProjectRoot} = {}) {
    const stats = {
        byteLength: 0,
        fileCount: 0,
        symlinkPaths: [],
    };

    async function walk(directory, relativeDirectory = '') {
        const entries = await readdir(directory, {withFileTypes: true});

        for (const dirent of entries) {
            if (shouldSkipSourcePath(dirent, relativeDirectory)) {
                continue;
            }

            const relativePath = path.join(relativeDirectory, dirent.name);
            const absolutePath = path.join(directory, dirent.name);
            const fileStat = await lstat(absolutePath);

            if (fileStat.isSymbolicLink()) {
                stats.symlinkPaths.push(relativePath);
                continue;
            }

            if (fileStat.isDirectory()) {
                await walk(absolutePath, relativePath);
                continue;
            }

            if (fileStat.isFile()) {
                stats.byteLength += fileStat.size;
                stats.fileCount += 1;
            }
        }
    }

    await walk(projectRoot);

    return stats;
}

export async function validateWebDeploySource({
    maxBytes = MAX_WEB_DEPLOY_SOURCE_BYTES,
    maxFiles = MAX_WEB_DEPLOY_SOURCE_FILES,
    projectRoot = defaultProjectRoot,
} = {}) {
    const vercelIgnoreContent = await readFile(path.join(projectRoot, '.vercelignore'), 'utf8');
    validateVercelIgnoreEntries(vercelIgnoreContent);

    const stats = await collectWebDeploySourceStats({projectRoot});

    if (stats.symlinkPaths.length > 0) {
        throw new Error(`Web deploy source contains symlinks: ${stats.symlinkPaths.join(', ')}`);
    }

    if (stats.fileCount > maxFiles) {
        throw new Error(`Web deploy source has too many files: ${stats.fileCount} > ${maxFiles}`);
    }

    if (stats.byteLength > maxBytes) {
        throw new Error(`Web deploy source is too large: ${stats.byteLength} > ${maxBytes} bytes`);
    }

    return stats;
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    try {
        const stats = await validateWebDeploySource();
        const mib = (stats.byteLength / 1024 / 1024).toFixed(1);
        console.log(`Web deploy source check passed: ${stats.fileCount} files, ${mib} MiB.`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
