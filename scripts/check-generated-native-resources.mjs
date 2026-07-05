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

function collectSourceMtimes(sourceRoot) {
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
    const workspaceLock = path.join(projectRoot, 'native', 'Cargo.lock');
    if (existsSync(workspaceLock)) {
        mtimes.push(statSync(workspaceLock).mtimeMs);
    }

    return mtimes;
}

export function assertGeneratedNativeResourceFresh(target, options = {}) {
    const root = options.projectRoot ?? projectRoot;
    const platformArch = `${normalizePlatform(target.platform)}-${target.arch}`;
    const staleStagingDirs = [];

    for (const tool of GENERATED_NATIVE_TOOLS) {
        const stagingDir = path.join(root, '.tmp', tool.stagingName, platformArch);
        const binaryPath = path.join(stagingDir, 'bin', getBinaryFileName(tool, target.platform));
        if (!existsSync(binaryPath)) {
            throw new Error(`Missing generated native payload: ${path.relative(root, binaryPath)}`);
        }

        const sourceRoot = path.join(root, 'native', tool.crateName);
        const sourceMtimes = collectSourceMtimes(sourceRoot);
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
        for (const dir of staleStagingDirs) {
            rmSync(dir, {
                force: true,
                recursive: true,
            });
        }
        throw new Error([
            `Stale generated native payloads for ${platformArch}; removed stale .tmp directories.`,
            ...staleStagingDirs.map(dir => `  ${path.relative(root, dir)}`),
            'Rebuild the Rust native tools before packaging.',
        ].join('\n'));
    }
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    const [
        platform,
        arch,
    ] = process.argv.slice(2);
    if (!platform || !arch) {
        console.error('Usage: node scripts/check-generated-native-resources.mjs <mac|win|linux> <x64|arm64>');
        process.exit(1);
    }

    try {
        assertGeneratedNativeResourceFresh({
            arch,
            platform,
        });
        console.log(`Generated native payloads are fresh for ${platform}-${arch}.`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
