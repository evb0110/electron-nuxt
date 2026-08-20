import {
    readdir,
    stat,
} from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const artifactRoots = [
    'dist-electron',
    'nuxt-output',
    '.vercel/output',
    '.output',
];

const ignoredMissingRoots = new Set(artifactRoots);
const allowedLicensePattern = /(?:^|[/\\])(?:LICENSE|LICENSE_[^/\\]+|LICENSE-[^/\\]+)(?:\.[^/\\]+)?$/iu;

const forbiddenPathPatterns = [
    /(?:^|[/\\])(?:__tests__|tests?|coverage|\.vitest|\.playwright)(?:[/\\]|$)/u,
    /\.(?:test|spec)\.[cm]?[jt]sx?$/u,
    /\.map$/u,
    /(?:^|[/\\])(?:README|CHANGELOG)(?:\.[^/\\]+)?$/iu,
    /(?:^|[/\\])favicon-dev[.-][^/\\]*$/u,
];

function isForbiddenArtifact(relativePath) {
    if (allowedLicensePattern.test(relativePath)) {
        return false;
    }

    return forbiddenPathPatterns.some(pattern => pattern.test(relativePath));
}

async function collectFiles(dirPath, relativeRoot) {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const absolutePath = path.join(dirPath, entry.name);
        const relativePath = path.join(relativeRoot, entry.name);

        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') {
                continue;
            }
            files.push(...await collectFiles(absolutePath, relativePath));
            continue;
        }

        if (entry.isFile()) {
            files.push(relativePath);
        }
    }

    return files;
}

async function collectArtifactFiles(relativeRoot) {
    const rootPath = path.join(projectRoot, relativeRoot);
    try {
        const rootStat = await stat(rootPath);
        if (!rootStat.isDirectory()) {
            return [];
        }
    } catch (error) {
        if (
            error
            && typeof error === 'object'
            && 'code' in error
            && error.code === 'ENOENT'
            && ignoredMissingRoots.has(relativeRoot)
        ) {
            return [];
        }
        throw error;
    }

    return collectFiles(rootPath, relativeRoot);
}

const forbiddenArtifacts = [];
for (const artifactRoot of artifactRoots) {
    const files = await collectArtifactFiles(artifactRoot);
    forbiddenArtifacts.push(...files.filter(isForbiddenArtifact));
}

if (forbiddenArtifacts.length > 0) {
    console.error('Build artifacts contain files that should not ship:');
    for (const artifact of forbiddenArtifacts.slice(0, 100)) {
        console.error(`  - ${artifact}`);
    }
    if (forbiddenArtifacts.length > 100) {
        console.error(`  ... and ${forbiddenArtifacts.length - 100} more`);
    }
    process.exit(1);
}

console.log('Build artifact hygiene check passed.');
