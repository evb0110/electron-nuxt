import {
    readdir,
    rm,
    stat,
} from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const buildRoots = [
    'dist-electron',
    'nuxt-output',
    '.vercel/output',
    '.output',
];

const removableDirectoryNames = new Set([
    '__tests__',
    'coverage',
]);

const removableFilePatterns = [
    /\.map$/u,
    /\.(?:test|spec)\.[cm]?[jt]sx?$/u,
    // Dev-only favicons referenced exclusively behind isDev in nuxt.config.ts.
    /^favicon-dev[.-]/u,
];

const removablePathSegmentPatterns = [
    /^tests?$/u,
    /^\.vitest$/u,
    /^\.playwright$/u,
];

function shouldRemoveEntry(entryName, isDirectory) {
    if (isDirectory) {
        return removableDirectoryNames.has(entryName)
            || removablePathSegmentPatterns.some(pattern => pattern.test(entryName));
    }

    return removableFilePatterns.some(pattern => pattern.test(entryName));
}

async function pruneDirectory(dirPath) {
    const entries = await readdir(dirPath, { withFileTypes: true });
    let removedCount = 0;

    for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        const isDirectory = entry.isDirectory();

        if (shouldRemoveEntry(entry.name, isDirectory)) {
            await rm(entryPath, {
                recursive: true,
                force: true,
            });
            removedCount += 1;
            continue;
        }

        if (isDirectory) {
            removedCount += await pruneDirectory(entryPath);
        }
    }

    return removedCount;
}

async function pruneBuildRoot(relativeRoot) {
    const root = path.join(projectRoot, relativeRoot);
    try {
        const rootStat = await stat(root);
        if (!rootStat.isDirectory()) {
            return 0;
        }
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            return 0;
        }
        throw error;
    }

    return pruneDirectory(root);
}

let totalRemoved = 0;
for (const buildRoot of buildRoots) {
    totalRemoved += await pruneBuildRoot(buildRoot);
}

if (totalRemoved > 0) {
    console.log(`Pruned ${totalRemoved} unnecessary build artifact(s).`);
}
