// Public because document opening must distinguish managed cleanup outputs from user files.
import {
    createHash,
    randomUUID,
} from 'crypto';
import {realpathSync} from 'fs';
import {
    mkdir,
    readdir,
    rm,
    stat,
} from 'fs/promises';
import {
    basename,
    extname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from 'path';
import {
    getAppTempDir,
    getAppTempDirPath,
} from '@electron/utils/appTempDir';

export const SCAN_CLEANUP_OUTPUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILENAME_BYTES = 255;

export function getScanCleanupOutputRoot(appTempDir = getAppTempDir()) {
    return join(appTempDir, 'scan-cleanup', 'output');
}

export function isScanCleanupGeneratedOutputPath(
    outputPath: string,
    appTempDir = getAppTempDirPath(),
) {
    let relativePath: string;
    try {
        relativePath = relative(
            realpathSync(getScanCleanupOutputRoot(appTempDir)),
            realpathSync(outputPath),
        );
    } catch {
        return false;
    }
    const segments = relativePath.split(sep);
    return relativePath.length > 0
        && relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath)
        && segments.length === 2
        && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(segments[0] ?? '')
        && extname(segments[1] ?? '').toLowerCase() === '.pdf';
}

function humanOutputName(sourcePdfPath: string, partial: boolean) {
    const sourceName = basename(sourcePdfPath, extname(sourcePdfPath)).trim() || 'document';
    const suffix = ` — cleaned${partial ? ' selection' : ''}.pdf`;
    if (Buffer.byteLength(`${sourceName}${suffix}`, 'utf8') <= MAX_FILENAME_BYTES) {
        return `${sourceName}${suffix}`;
    }
    const collisionHash = createHash('sha256').update(sourcePdfPath).digest('hex').slice(0, 12);
    const reserved = `-${collisionHash}${suffix}`;
    const budget = MAX_FILENAME_BYTES - Buffer.byteLength(reserved, 'utf8');
    let truncated = '';
    let used = 0;
    for (const character of sourceName) {
        const bytes = Buffer.byteLength(character, 'utf8');
        if (used + bytes > budget) break;
        truncated += character;
        used += bytes;
    }
    return `${truncated || 'document'}${reserved}`;
}

export async function createScanCleanupGeneratedOutputPath(
    sourcePdfPath: string,
    partial = false,
    appTempDir = getAppTempDir(),
) {
    const outputDirectory = join(getScanCleanupOutputRoot(appTempDir), randomUUID());
    await mkdir(outputDirectory, {
        recursive: true,
        mode: 0o700,
    });
    return join(outputDirectory, humanOutputName(sourcePdfPath, partial));
}

export async function pruneScanCleanupGeneratedOutputs(options: {
    appTempDir?: string;
    openPdfPaths: readonly string[];
    nowMs?: number;
}) {
    const outputRoot = getScanCleanupOutputRoot(options.appTempDir);
    const resolvedRoot = resolve(outputRoot);
    const openPaths = new Set(options.openPdfPaths.map(path => resolve(path)));
    const nowMs = options.nowMs ?? Date.now();
    let entries;
    try {
        entries = await readdir(outputRoot, {withFileTypes: true});
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return 0;
        }
        throw error;
    }

    let removed = 0;
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const directoryPath = join(outputRoot, entry.name);
        const resolvedDirectory = resolve(directoryPath);
        if (!resolvedDirectory.startsWith(`${resolvedRoot}${process.platform === 'win32' ? '\\' : '/'}`)) continue;
        const files = await readdir(directoryPath, {withFileTypes: true}).catch(() => []);
        const containsOpenPdf = files.some(file => file.isFile() && openPaths.has(resolve(directoryPath, file.name)));
        if (containsOpenPdf) continue;
        const metadata = await stat(directoryPath).catch(() => null);
        if (!metadata || nowMs - metadata.mtimeMs < SCAN_CLEANUP_OUTPUT_MAX_AGE_MS) continue;
        await rm(directoryPath, {
            recursive: true,
            force: true,
        });
        removed += 1;
    }
    return removed;
}
