import {
    lstat,
    readdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MAX_WEB_DEPLOY_SOURCE_FILES = 14_000;
export const MAX_WEB_DEPLOY_SOURCE_BYTES = 128 * 1024 * 1024;

export const WEB_DEPLOY_SOURCE_EXCLUDED_DIRECTORY_NAMES = [
    '.angular',
    '.cache',
    '.claude',
    '.codex',
    '.devkit',
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
    '.playwright-mcp',
    '.svelte-kit',
    '.tmp',
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
    'python',
    'release',
    'resources',
    'tests',
];

export const WEB_DEPLOY_SOURCE_EXCLUDED_FILE_NAMES = [
    '.DS_Store',
    'electron-builder.yml',
    'eslint-plugin-custom.mjs',
];

export const REQUIRED_VERCELIGNORE_ENTRIES = [
    ...WEB_DEPLOY_SOURCE_EXCLUDED_DIRECTORY_NAMES.map(name => `${name}/`),
    ...WEB_DEPLOY_SOURCE_EXCLUDED_FILE_NAMES,
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

function shouldSkipSourcePath(dirent) {
    if (dirent.isDirectory()) {
        return WEB_DEPLOY_SOURCE_EXCLUDED_DIRECTORY_NAMES.includes(dirent.name);
    }

    return WEB_DEPLOY_SOURCE_EXCLUDED_FILE_NAMES.includes(dirent.name)
        || isExcludedEnvFileName(dirent.name);
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
            if (shouldSkipSourcePath(dirent)) {
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
