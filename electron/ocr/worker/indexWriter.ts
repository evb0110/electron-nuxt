import {randomUUID} from 'crypto';
import {
    lstat,
    mkdir,
    readFile,
    realpath,
    rename,
    writeFile,
} from 'fs/promises';
import {
    dirname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from 'path';
import type {
    IOcrIndexV2Manifest,
    IOcrIndexV2Page,
    IOcrPageWithWords,
    TWorkerLog,
} from '@electron/ocr/worker/types';
import { isRecord } from '@contracts/runtimeGuards';

function isPathInsideBaseDir(baseDir: string, candidatePath: string) {
    const relativePath = relative(baseDir, candidatePath);
    return (
        relativePath !== ''
        && relativePath !== '.'
        && relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath)
    );
}

function isPathInsideAnyBaseDir(baseDirs: string[], candidatePath: string) {
    return baseDirs.some(baseDir => isPathInsideBaseDir(baseDir, candidatePath));
}

function parseOcrIndexV2Manifest(rawManifest: string): IOcrIndexV2Manifest | null {
    const parsed: unknown = JSON.parse(rawManifest);
    if (!isRecord(parsed) || !isRecord(parsed.pages) || !isRecord(parsed.source)) {
        return null;
    }
    const pageCount = parsed.pageCount;
    if (
        parsed.version !== 2
        || typeof parsed.source.pdfPath !== 'string'
        || typeof pageCount !== 'number'
        || !Number.isInteger(pageCount)
        || pageCount <= 0
    ) {
        return null;
    }
    const pages: IOcrIndexV2Manifest['pages'] = {};
    for (const [
        rawPageNumber,
        rawPageMapping,
    ] of Object.entries(parsed.pages)) {
        const pageNumber = parseManifestPageNumber(rawPageNumber);
        if (
            pageNumber !== null
            && isRecord(rawPageMapping)
            && typeof rawPageMapping.path === 'string'
            && rawPageMapping.path.length > 0
        ) {
            pages[pageNumber] = { path: rawPageMapping.path };
        }
    }
    return {
        version: 2,
        createdAt: typeof parsed.createdAt === 'number' && Number.isFinite(parsed.createdAt)
            ? parsed.createdAt
            : Date.now(),
        source: { pdfPath: parsed.source.pdfPath },
        pageCount,
        pageBox: 'crop',
        ocr: {
            engine: 'tesseract',
            languages: [],
            renderDpi: 0,
        },
        pages,
    };
}

async function readExistingOcrIndexV2Manifest(ocrDir: string): Promise<IOcrIndexV2Manifest | null> {
    try {
        const rawManifest = await readFile(join(ocrDir, 'manifest.json'), 'utf-8');
        return parseOcrIndexV2Manifest(rawManifest);
    } catch {
        return null;
    }
}

function parseManifestPageNumber(value: string) {
    const pageNumber = Number.parseInt(value, 10);
    return Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : null;
}

function shouldPreserveExistingOcrManifest(
    manifest: IOcrIndexV2Manifest | null,
    workingCopyPath: string,
    pageCount: number,
) {
    return !!manifest
        && manifest.pageCount === pageCount
        && resolve(manifest.source.pdfPath) === resolve(workingCopyPath);
}

function copyPreservedPageMappings(
    manifest: IOcrIndexV2Manifest | null,
    workingCopyPath: string,
    pageCount: number,
) {
    if (!manifest || !shouldPreserveExistingOcrManifest(manifest, workingCopyPath, pageCount)) {
        return {};
    }

    const pages: IOcrIndexV2Manifest['pages'] = {};
    for (const [
        rawPageNumber,
        pageMapping,
    ] of Object.entries(manifest.pages)) {
        const pageNumber = parseManifestPageNumber(rawPageNumber);
        if (
            pageNumber !== null
            && pageNumber <= pageCount
            && typeof pageMapping.path === 'string'
            && pageMapping.path.length > 0
        ) {
            pages[pageNumber] = { path: pageMapping.path };
        }
    }

    return pages;
}

function createUniqueTempPath(targetPath: string) {
    return `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
}

export async function resolveSafeOcrIndexBasePath(
    indexPath: string,
    tempDirPath: string,
): Promise<string> {
    const normalizedPath = indexPath.trim();
    if (!normalizedPath) {
        throw new Error('OCR index path must not be empty');
    }

    const absoluteIndexPath = resolve(normalizedPath);
    const absoluteTempDir = resolve(tempDirPath);
    const tempBaseDirs = [absoluteTempDir];
    try {
        const canonicalTempDir = await realpath(absoluteTempDir);
        if (canonicalTempDir !== absoluteTempDir) {
            tempBaseDirs.push(canonicalTempDir);
        }
    } catch {
        // Keep the non-canonical temp directory as the fallback base.
    }

    if (!isPathInsideAnyBaseDir(tempBaseDirs, absoluteIndexPath)) {
        throw new Error('OCR index path is outside the allowed temp directory');
    }

    const indexStat = await lstat(absoluteIndexPath).catch(() => null);
    if (!indexStat) {
        throw new Error('OCR index path does not exist');
    }
    if (indexStat.isSymbolicLink()) {
        throw new Error('OCR index path cannot be a symbolic link');
    }

    const resolvedIndexPath = await realpath(absoluteIndexPath);
    if (!isPathInsideAnyBaseDir(tempBaseDirs, resolvedIndexPath)) {
        throw new Error('OCR index path resolves outside the allowed temp directory');
    }

    const resolvedParentDir = await realpath(dirname(resolvedIndexPath));
    const isInsideTempDir = isPathInsideAnyBaseDir(tempBaseDirs, resolvedParentDir) || tempBaseDirs.includes(resolvedParentDir);
    if (!isInsideTempDir) {
        throw new Error('OCR index path parent directory is outside the allowed temp directory');
    }

    return resolvedIndexPath;
}

export async function writeOcrIndexV2(
    workingCopyPath: string,
    ocrPageData: IOcrPageWithWords[],
    pageCount: number,
    languages: string[],
    extractionDpi: number,
    log: TWorkerLog,
): Promise<void> {
    const ocrDir = `${workingCopyPath}.ocr`;
    await mkdir(ocrDir, { recursive: true });
    const existingManifest = await readExistingOcrIndexV2Manifest(ocrDir);

    const manifest: IOcrIndexV2Manifest = {
        version: 2,
        createdAt: Date.now(),
        source: { pdfPath: workingCopyPath },
        pageCount,
        pageBox: 'crop',
        ocr: {
            engine: 'tesseract',
            languages,
            renderDpi: extractionDpi,
        },
        pages: copyPreservedPageMappings(existingManifest, workingCopyPath, pageCount),
    };

    for (const pd of ocrPageData) {
        const pageFile = `page-${String(pd.pageNumber).padStart(4, '0')}.json`;

        const pageData: IOcrIndexV2Page = {
            pageNumber: pd.pageNumber,
            rotation: 0,
            render: {
                dpi: extractionDpi,
                imagePx: {
                    w: pd.imageWidth,
                    h: pd.imageHeight,
                },
            },
            text: pd.text,
            words: pd.words,
        };

        const pagePath = join(ocrDir, pageFile);
        const tempPath = createUniqueTempPath(pagePath);
        await writeFile(tempPath, JSON.stringify(pageData), 'utf-8');
        await rename(tempPath, pagePath);

        manifest.pages[pd.pageNumber] = { path: pageFile };
    }

    const manifestPath = join(ocrDir, 'manifest.json');
    const tempManifestPath = createUniqueTempPath(manifestPath);
    await writeFile(tempManifestPath, JSON.stringify(manifest), 'utf-8');
    await rename(tempManifestPath, manifestPath);

    log('debug', `Wrote OCR index v2 to ${ocrDir} with ${ocrPageData.length} pages`);
}

export async function writeOcrIndexV1(
    indexPath: string,
    ocrPageData: IOcrPageWithWords[],
    pageCount: number,
): Promise<void> {
    const indexPageData = ocrPageData.map(pd => ({
        pageNumber: pd.pageNumber,
        words: pd.words,
        text: pd.text,
        pageWidth: pd.imageWidth,
        pageHeight: pd.imageHeight,
    }));

    const indexContent = JSON.stringify({
        version: 1,
        pageCount,
        pages: indexPageData,
    });

    await writeFile(`${indexPath}.index.json`, indexContent, 'utf-8');
}
