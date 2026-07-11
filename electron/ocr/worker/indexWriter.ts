import {
    createHash,
    randomUUID,
} from 'crypto';
import {
    cp,
    lstat,
    mkdir,
    readFile,
    realpath,
    rename,
    rm,
    stat,
    unlink,
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
    IOcrPageWithWords,
    TWorkerLog,
} from '@electron/ocr/worker/types';
import type {
    IOcrIndexV3Manifest,
    IOcrIndexV3Page,
} from '@contracts/ocrIndex';
import {
    decodeOcrPage,
    parseOcrIndexV3Manifest as decodeOcrIndexV3Manifest,
} from '@contracts/ocrIndex';
import type {
    IDocumentRevisionInfo,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {
    OCR_TEXT_LAYER_INDEX_VERSION,
    buildOcrTextLayerIndexText,
} from '@contracts/ocrText';
import {
    COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
    loadCompactSearchIndex,
    persistCompactSearchIndex,
} from '@electron/search/searchIndexSidecar';
import { getErrorMessage } from '@electron/utils/error';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
import { assertWorkingCopyRevisionSidecarCurrent as assertWorkingCopyRevisionCurrent } from '@electron/file-access/documentRevisionSidecar';

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

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

function parseOcrIndexV3Manifest(rawManifest: string): IOcrIndexV3Manifest | null {
    return decodeOcrIndexV3Manifest(JSON.parse(rawManifest), 'strict');
}

async function readExistingOcrIndexV3Manifest(ocrDir: string): Promise<IOcrIndexV3Manifest | null> {
    try {
        const rawManifest = await readFile(join(ocrDir, 'manifest.json'), 'utf-8');
        return parseOcrIndexV3Manifest(rawManifest);
    } catch {
        return null;
    }
}

function parseManifestPageNumber(value: string) {
    const pageNumber = Number.parseInt(value, 10);
    return Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : null;
}

function shouldPreserveExistingOcrManifest(
    manifest: IOcrIndexV3Manifest | null,
    workingCopyPath: string,
    pageCount: number,
    documentRevision: IDocumentRevisionInfo,
) {
    return !!manifest
        && manifest.pageCount === pageCount
        && manifest.documentRevision.token === documentRevision.token
        && resolve(manifest.source.pdfPath) === resolve(workingCopyPath);
}

function copyPreservedPageMappings(
    manifest: IOcrIndexV3Manifest | null,
    workingCopyPath: string,
    pageCount: number,
    ocrDir: string,
    documentRevision: IDocumentRevisionInfo,
) {
    if (!manifest || !shouldPreserveExistingOcrManifest(manifest, workingCopyPath, pageCount, documentRevision)) {
        return {};
    }

    const pages: IOcrIndexV3Manifest['pages'] = {};
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
            && resolveManifestPagePath(ocrDir, pageMapping.path) !== null
        ) {
            pages[pageNumber] = { path: pageMapping.path };
        }
    }

    return pages;
}

function createUniqueTempPath(targetPath: string) {
    return `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
}

async function statMtimeMs(filePath: string) {
    try {
        const fileStat = await stat(filePath);
        return typeof fileStat.mtimeMs === 'number' && Number.isFinite(fileStat.mtimeMs)
            ? fileStat.mtimeMs
            : undefined;
    } catch {
        return undefined;
    }
}

async function unlinkIfPresent(filePath: string) {
    try {
        await unlink(filePath);
    } catch {
        // Keep cleanup best-effort.
    }
}

async function renameIfPresent(sourcePath: string, targetPath: string) {
    try {
        await rename(sourcePath, targetPath);
    } catch {
        // Keep rollback best-effort.
    }
}

function assertValidOcrPageData(
    ocrPageData: readonly IOcrPageWithWords[],
    pageCount: number,
) {
    const seenPageNumbers = new Set<number>();
    for (const pageData of ocrPageData) {
        if (
            !Number.isSafeInteger(pageData.pageNumber)
            || pageData.pageNumber < 1
            || pageData.pageNumber > pageCount
        ) {
            throw new Error(`Invalid OCR page number ${pageData.pageNumber}`);
        }
        if (seenPageNumbers.has(pageData.pageNumber)) {
            throw new Error(`Duplicate OCR page number ${pageData.pageNumber}`);
        }
        seenPageNumbers.add(pageData.pageNumber);
    }
}

async function moveExistingFileAside(filePath: string) {
    const backupPath = createUniqueTempPath(`${filePath}.bak`);
    try {
        await rename(filePath, backupPath);
        return backupPath;
    } catch (error) {
        if (
            error
            && typeof error === 'object'
            && 'code' in error
            && error.code === 'ENOENT'
        ) {
            return null;
        }
        throw error;
    }
}

function buildOcrSearchText(page: Pick<IOcrPageWithWords, 'text' | 'words'>) {
    if (page.text.length > 0) {
        return page.text;
    }
    return page.words.length > 0
        ? buildOcrTextLayerIndexText(page.words)
        : page.text;
}

function resolveManifestPagePath(
    ocrDir: string,
    relativePath: unknown,
) {
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
        return null;
    }

    const resolvedOcrDir = resolve(ocrDir);
    const resolvedPath = resolve(resolvedOcrDir, relativePath);
    const relativePathFromDir = relative(resolvedOcrDir, resolvedPath);
    if (
        relativePathFromDir === ''
        || relativePathFromDir === '..'
        || relativePathFromDir.startsWith(`..${sep}`)
        || isAbsolute(relativePathFromDir)
    ) {
        return null;
    }

    return resolvedPath;
}

function parseOcrPageTextPayload(
    payload: unknown,
    expectedPageNumber: number,
    expectedDocumentRevisionToken: TDocumentRevisionToken,
) {
    const page = decodeOcrPage(
        payload,
        expectedPageNumber,
        expectedDocumentRevisionToken,
        'repair-legacy',
    );
    if (!page) {
        return null;
    }
    return page.text || (page.words.length > 0 ? buildOcrTextLayerIndexText(page.words) : '');
}

async function readOcrPageSearchText(
    ocrDir: string,
    pageMapping: { path: string },
    pageNumber: number,
    documentRevisionToken: TDocumentRevisionToken,
) {
    const pagePath = resolveManifestPagePath(ocrDir, pageMapping.path);
    if (!pagePath) {
        return null;
    }
    try {
        return parseOcrPageTextPayload(
            JSON.parse(await readFile(pagePath, 'utf-8')),
            pageNumber,
            documentRevisionToken,
        );
    } catch {
        return null;
    }
}

async function seedSearchSidecarTextsFromExistingCompactIndex(
    workingCopyPath: string,
    documentRevisionToken: TDocumentRevisionToken,
    pageCount: number,
    existingManifestMtimeMs: number | undefined,
) {
    const textsByPage = new Map<number, string>();
    const requiredTextSource = {
        kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
        version: OCR_TEXT_LAYER_INDEX_VERSION,
    };
    const loadOptions: NonNullable<Parameters<typeof loadCompactSearchIndex>[1]> = {
        documentRevision: documentRevisionToken,
        requiredTextSource,
    };
    if (existingManifestMtimeMs !== undefined) {
        loadOptions.minSourceMtimeMs = existingManifestMtimeMs;
    }
    const existingCompactIndex = await loadCompactSearchIndex(workingCopyPath, loadOptions);
    if (!existingCompactIndex || existingCompactIndex.pageCount !== pageCount) {
        return textsByPage;
    }

    for (const page of existingCompactIndex.pages) {
        if (page.pageNumber > 0 && page.pageNumber <= pageCount) {
            textsByPage.set(page.pageNumber, page.text);
        }
    }
    return textsByPage;
}

async function collectCompactSearchIndexPages(
    workingCopyPath: string,
    ocrDir: string,
    manifest: IOcrIndexV3Manifest,
    ocrPageData: IOcrPageWithWords[],
    existingManifestMtimeMs: number | undefined,
) {
    const manifestPageNumbers: number[] = [];
    for (const pageKey of Object.keys(manifest.pages)) {
        const pageNumber = parseManifestPageNumber(pageKey);
        if (pageNumber !== null && pageNumber <= manifest.pageCount) {
            manifestPageNumbers.push(pageNumber);
        }
    }
    manifestPageNumbers.sort((a, b) => a - b);

    const textsByPage = await seedSearchSidecarTextsFromExistingCompactIndex(
        workingCopyPath,
        manifest.documentRevision.token,
        manifest.pageCount,
        existingManifestMtimeMs,
    );
    for (const page of ocrPageData) {
        textsByPage.set(page.pageNumber, buildOcrSearchText(page));
    }

    for (const pageNumber of manifestPageNumbers) {
        if (textsByPage.has(pageNumber)) {
            continue;
        }
        const pageMapping = manifest.pages[pageNumber];
        if (!pageMapping) {
            continue;
        }
        const text = await readOcrPageSearchText(
            ocrDir,
            pageMapping,
            pageNumber,
            manifest.documentRevision.token,
        );
        if (text !== null) {
            textsByPage.set(pageNumber, text);
        }
    }

    const pages: Array<{
        pageNumber: number;
        text: string;
    }> = [];
    for (const pageNumber of manifestPageNumbers) {
        const text = textsByPage.get(pageNumber);
        if (text !== undefined) {
            pages.push({
                pageNumber,
                text,
            });
        }
    }

    return pages.length === manifestPageNumbers.length
        ? pages
        : null;
}

async function writeCompactSearchIndexForOcr(
    workingCopyPath: string,
    ocrDir: string,
    manifest: IOcrIndexV3Manifest,
    ocrPageData: IOcrPageWithWords[],
    existingManifestMtimeMs: number | undefined,
    log: TWorkerLog,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    await assertWorkingCopyRevisionCurrent(workingCopyPath, manifest.documentRevision.token);
    const pages = await collectCompactSearchIndexPages(
        workingCopyPath,
        ocrDir,
        manifest,
        ocrPageData,
        existingManifestMtimeMs,
    );
    if (!pages) {
        log('debug', `Skipped compact OCR search sidecar for ${workingCopyPath}: preserved OCR page text is incomplete`);
        return;
    }

    try {
        throwIfAborted(signal);
        await persistCompactSearchIndex(workingCopyPath, {
            documentRevision: manifest.documentRevision.token,
            pageCount: manifest.pageCount,
            pages,
            textSource: {
                kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
                version: OCR_TEXT_LAYER_INDEX_VERSION,
            },
        }, signal);
        log('debug', `Wrote compact OCR search sidecar for ${workingCopyPath} with ${pages.length} pages`);
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        log('warn', `Failed to write compact OCR search sidecar: ${getErrorMessage(error)}`);
        throw error;
    }
}

export async function resolveSafeOcrIndexBasePath(
    indexPath: string,
    tempDirPath: string,
) {
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

export async function writeOcrIndexV3(
    workingCopyPath: string,
    documentRevision: IDocumentRevisionInfo,
    ocrPageData: IOcrPageWithWords[],
    pageCount: number,
    languages: string[],
    extractionDpi: number,
    log: TWorkerLog,
    signal?: AbortSignal,
    stagedResultPdfPath?: string,
) {
    throwIfAborted(signal);
    assertValidOcrPageData(ocrPageData, pageCount);
    const liveOcrDir = `${workingCopyPath}.ocr`;
    const ocrDir = `${stagedResultPdfPath ?? workingCopyPath}.ocr`;
    if (stagedResultPdfPath) {
        await rm(ocrDir, {
            recursive: true,
            force: true,
        });
        await cp(liveOcrDir, ocrDir, {recursive: true}).catch((error: unknown) => {
            if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
                throw error;
            }
        });
    }
    await mkdir(ocrDir, { recursive: true });
    const manifestPath = join(ocrDir, 'manifest.json');
    const existingManifest = await readExistingOcrIndexV3Manifest(ocrDir);
    const existingManifestMtimeMs = existingManifest
        ? await statMtimeMs(manifestPath)
        : undefined;

    const manifest: IOcrIndexV3Manifest = {
        version: 3,
        documentRevision: {token: documentRevision.token},
        createdAt: Date.now(),
        source: { pdfPath: workingCopyPath },
        pageCount,
        pageBox: 'crop',
        ocr: {
            engine: 'tesseract',
            languages,
            renderDpi: extractionDpi,
        },
        pages: copyPreservedPageMappings(existingManifest, workingCopyPath, pageCount, ocrDir, documentRevision),
    };
    const generation = randomUUID();

    const tempPaths = new Set<string>();
    const backups: Array<{
        pagePath: string;
        backupPath: string;
    }> = [];
    const writtenPagePaths = new Set<string>();
    let manifestCommitted = false;
    let publishCommitted = false;
    let manifestBackupPath: string | null = null;

    try {
        await assertWorkingCopyRevisionCurrent(workingCopyPath, documentRevision.token);
        for (const pd of ocrPageData) {
            throwIfAborted(signal);
            const pageFile = `page-${String(pd.pageNumber).padStart(4, '0')}.json`;

            const pageData: IOcrIndexV3Page = {
                pageNumber: pd.pageNumber,
                rotation: 0,
                documentRevision: {token: documentRevision.token},
                render: {
                    dpi: extractionDpi,
                    imagePx: {
                        w: pd.imageWidth,
                        h: pd.imageHeight,
                    },
                },
                text: pd.text,
                words: pd.words,
                canonicalText: {
                    source: 'evb-ocr',
                    generation,
                    contentDigest: createHash('sha256').update(JSON.stringify({
                        pageNumber: pd.pageNumber,
                        text: pd.text,
                        words: pd.words,
                    })).digest('hex'),
                },
            };

            const pagePath = join(ocrDir, pageFile);
            const tempPath = createUniqueTempPath(pagePath);
            tempPaths.add(tempPath);
            await writeFile(tempPath, JSON.stringify(pageData), 'utf-8');
            throwIfAborted(signal);

            const backupPath = await moveExistingFileAside(pagePath);
            if (backupPath) {
                backups.push({
                    pagePath,
                    backupPath,
                });
            }
            await rename(tempPath, pagePath);
            tempPaths.delete(tempPath);
            writtenPagePaths.add(pagePath);

            manifest.pages[pd.pageNumber] = { path: pageFile };
        }

        throwIfAborted(signal);
        const tempManifestPath = createUniqueTempPath(manifestPath);
        tempPaths.add(tempManifestPath);
        await writeFile(tempManifestPath, JSON.stringify(manifest), 'utf-8');
        throwIfAborted(signal);
        await assertWorkingCopyRevisionCurrent(workingCopyPath, documentRevision.token);
        manifestBackupPath = await moveExistingFileAside(manifestPath);
        await rename(tempManifestPath, manifestPath);
        tempPaths.delete(tempManifestPath);
        manifestCommitted = true;
        if (!stagedResultPdfPath) {
            await writeCompactSearchIndexForOcr(
                workingCopyPath,
                ocrDir,
                manifest,
                ocrPageData,
                existingManifestMtimeMs,
                log,
                signal,
            );
        }
        publishCommitted = true;
    } catch (error) {
        await Promise.all(Array.from(tempPaths, path => unlinkIfPresent(path)));
        if (!publishCommitted) {
            if (manifestCommitted) {
                await unlinkIfPresent(manifestPath);
            }
            if (manifestBackupPath) {
                await renameIfPresent(manifestBackupPath, manifestPath);
            }
            await Promise.all(Array.from(writtenPagePaths, path => unlinkIfPresent(path)));
            await Promise.all(backups.map(backup => renameIfPresent(backup.backupPath, backup.pagePath)));
        }
        throw error;
    } finally {
        if (publishCommitted) {
            if (manifestBackupPath) {
                await unlinkIfPresent(manifestBackupPath);
            }
            await Promise.all(backups.map(backup => unlinkIfPresent(backup.backupPath)));
        }
    }

    log('debug', `Wrote OCR index v3 to ${ocrDir} with ${ocrPageData.length} pages`);
}
