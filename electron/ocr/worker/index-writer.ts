import {
    lstat,
    mkdir,
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
        pages: {},
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
        const tempPath = `${pagePath}.tmp`;
        await writeFile(tempPath, JSON.stringify(pageData), 'utf-8');
        await rename(tempPath, pagePath);

        manifest.pages[pd.pageNumber] = { path: pageFile };
    }

    const manifestPath = join(ocrDir, 'manifest.json');
    const tempManifestPath = `${manifestPath}.tmp`;
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
