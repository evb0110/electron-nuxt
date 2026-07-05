import {
    existsSync,
    readdirSync,
    rmSync,
    statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const GENERATED_NATIVE_TOOLS = [
    {
        binaryName: 'evb-pdf-image-combine',
        crateName: 'pdf-image-combine',
        stagingName: 'pdf-image-combine',
    },
    {
        binaryName: 'evb-pdf-page-ops',
        crateName: 'pdf-page-ops',
        stagingName: 'pdf-page-ops',
    },
    {
        binaryName: 'evb-pdf-search',
        crateName: 'pdf-search',
        stagingName: 'pdf-search',
    },
];

const sourceFileNames = new Set([
    'Cargo.lock',
    'Cargo.toml',
]);

export function detectHostGeneratedNativeResourceTarget({
    nodeArch = process.arch,
    nodePlatform = process.platform,
} = {}) {
    let platform;
    switch (nodePlatform) {
        case 'darwin':
            platform = 'mac';
            break;
        case 'linux':
            platform = 'linux';
            break;
        case 'win32':
            platform = 'win';
            break;
        default:
            throw new Error(`Unsupported host platform for generated native resource checks: ${nodePlatform}`);
    }

    if (nodeArch !== 'arm64' && nodeArch !== 'x64') {
        throw new Error(`Unsupported host arch for generated native resource checks: ${nodeArch}`);
    }

    return {
        arch: nodeArch,
        platform,
    };
}

function normalizePlatform(platform) {
    if (platform === 'mac') {
        return 'darwin';
    }
    if (platform === 'win') {
        return 'win32';
    }
    return platform;
}

function getBinaryFileName(tool, platform) {
    return normalizePlatform(platform) === 'win32'
        ? `${tool.binaryName}.exe`
        : tool.binaryName;
}

function collectSourceMtimes(sourceRoot, root = projectRoot) {
    const mtimes = [];
    const visit = (entryPath) => {
        const stat = statSync(entryPath);
        if (stat.isDirectory()) {
            for (const child of readdirSync(entryPath)) {
                if (child === 'target') {
                    continue;
                }
                visit(path.join(entryPath, child));
            }
            return;
        }
        if (stat.isFile() && (entryPath.endsWith('.rs') || sourceFileNames.has(path.basename(entryPath)))) {
            mtimes.push(stat.mtimeMs);
        }
    };

    if (existsSync(sourceRoot)) {
        visit(sourceRoot);
    }
    const workspaceLock = path.join(root, 'native', 'Cargo.lock');
    if (existsSync(workspaceLock)) {
        mtimes.push(statSync(workspaceLock).mtimeMs);
    }

    return mtimes;
}

export function assertGeneratedNativeResourceFresh(target, options = {}) {
    const root = options.projectRoot ?? projectRoot;
    const pruneStale = options.pruneStale === true;
    const platformArch = `${normalizePlatform(target.platform)}-${target.arch}`;
    const staleStagingDirs = [];

    for (const tool of GENERATED_NATIVE_TOOLS) {
        const stagingDir = path.join(root, '.tmp', tool.stagingName, platformArch);
        const binaryPath = path.join(stagingDir, 'bin', getBinaryFileName(tool, target.platform));
        if (!existsSync(binaryPath)) {
            throw new Error(`Missing generated native payload: ${path.relative(root, binaryPath)}`);
        }

        const sourceRoot = path.join(root, 'native', tool.crateName);
        const sourceMtimes = collectSourceMtimes(sourceRoot, root);
        if (sourceMtimes.length === 0) {
            throw new Error(`No Rust source inputs found for ${tool.crateName}`);
        }

        const binaryMtime = statSync(binaryPath).mtimeMs;
        const newestSourceMtime = Math.max(...sourceMtimes);
        if (binaryMtime < newestSourceMtime) {
            staleStagingDirs.push(stagingDir);
        }
    }

    if (staleStagingDirs.length > 0) {
        if (pruneStale) {
            for (const dir of staleStagingDirs) {
                rmSync(dir, {
                    force: true,
                    recursive: true,
                });
            }
        }
        throw new Error([
            pruneStale
                ? `Stale generated native payloads for ${platformArch}; removed stale .tmp directories.`
                : `Stale generated native payloads for ${platformArch}.`,
            ...staleStagingDirs.map(dir => `  ${path.relative(root, dir)}`),
            pruneStale
                ? 'Rebuild the Rust native tools before packaging.'
                : 'Rebuild the Rust native tools before packaging, or rerun with --prune-stale to remove stale .tmp directories.',
        ].join('\n'));
    }
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    const argv = process.argv.slice(2);
    const pruneStale = argv.includes('--prune-stale');
    const positionalArgs = argv.filter(argument => argument !== '--prune-stale');
    let target;

    if (positionalArgs.length === 1 && positionalArgs[0] === '--host') {
        target = detectHostGeneratedNativeResourceTarget();
    } else if (positionalArgs.length === 2) {
        target = {
            arch: positionalArgs[1],
            platform: positionalArgs[0],
        };
    } else {
        console.error(
            'Usage: node scripts/check-generated-native-resources.mjs [--prune-stale] '
            + '--host | <mac|win|linux> <x64|arm64>',
        );
        process.exit(1);
    }

    try {
        assertGeneratedNativeResourceFresh(target, { pruneStale });
        console.log(`Generated native payloads are fresh for ${target.platform}-${target.arch}.`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
