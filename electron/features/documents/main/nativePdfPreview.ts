import {
    mkdtemp,
    readFile,
    rm,
    stat,
} from 'fs/promises';
import {
    basename,
    dirname,
    join,
} from 'path';
import { tmpdir } from 'os';
import type {
    IPdfNativePagePreview,
    IPdfNativePagePreviewOptions,
    IPdfNativePageSize,
    IPdfOpeningGeometry,
} from '@contracts/electronApiDocuments';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';
import { resolveOriginalBackedReadTransport } from '@electron/features/documents/main/documentFileReadHandlers';
import { resolveExistingReadablePdfPath } from '@electron/features/documents/main/documentFilePathResolution';
import { allowOpenPath } from '@electron/file-access/openPathCapabilities';
import { getRecentFiles } from '@electron/recentFiles';
import { buildPopplerEnv } from '@electron/native-tools/buildPopplerEnv';
import {
    runNativeToolCommand,
    type IRunNativeToolCommandOptions,
} from '@electron/native-tools/runNativeToolCommand';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { cancelNativeCommandGroup } from '@electron/native-tools/runNativeCommand';
import { registerMainOperation } from '@electron/operation-lifecycle/mainOperationLifecycle';
import { abortErrorFromSignal } from '@electron/utils/abort';
import { mainJobBroker } from '@electron/resources/jobBroker';
import type { IJobBrokerLease } from '@electron/resources/jobBroker';
import { createLogger } from '@electron/utils/createLogger';
import { acquireNativePdfPreviewAdmission } from '@electron/features/documents/main/acquireNativePdfPreviewAdmission';
import { isErrnoException } from '@contracts/runtimeGuards';
import { isWorkingCopyDirectoryName } from '@electron/file-access/workingCopyDirectory';
import { getWorkingCopyBackingEntry } from '@electron/file-access/workingCopyStore';

const PDFINFO_TIMEOUT_MS = 20_000;
const PDFIMAGES_TIMEOUT_MS = 10_000;
const PDF_RENDER_TIMEOUT_MS = 30_000;
const PDFINFO_DETAILED_PAGE_LIMIT = 5_000;
const PDF_NATIVE_MAX_PAGE_COUNT = 100_000;
const PDFINFO_BASE_STDOUT_BYTES = 256 * 1024;
const PDFINFO_PER_PAGE_STDOUT_BYTES = 512;
const PDFIMAGES_PAGE_STDOUT_BYTES = 256 * 1024;
const PDF_RENDER_DEFAULT_TARGET_WIDTH_PX = 1_200;
const PDF_RENDER_MIN_TARGET_WIDTH_PX = 64;
const PDF_RENDER_MAX_TARGET_WIDTH_PX = 4_096;
const PDF_RENDER_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const PDF_RENDER_MAX_OUTPUT_PIXELS = 64 * 1024 * 1024;
const PDF_RASTER_PAGE_COVERAGE_TOLERANCE = 0.02;
const PDF_RASTER_CEILING_CACHE_LIMIT = 1_024;
const logger = createLogger('native-pdf-preview');

const PAGE_COUNT_RE = /^Pages:\s+(\d+)\s*$/imu;
const DEFAULT_PAGE_SIZE_RE = /^Page size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts\b/imu;
const PAGE_SIZE_RE = /^Page\s+(\d+)\s+size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts\b/gimu;
const PAGE_ROTATION_RE = /^Page\s+(\d+)\s+rot:\s+(-?\d+)\s*$/gimu;

const activePreviewAborters = new Map<string, (reason: string) => void>();
const activePreviewPromises = new Map<string, Promise<IPdfNativePagePreview>>();
const rasterCeilingByRevisionPage = new Map<string, number | null>();

interface IPdfPageGeometry {
    height: number;
    rotation: 0 | 90 | 180 | 270;
    width: number;
}

function cacheRasterCeiling(key: string, ceiling: number | null) {
    rasterCeilingByRevisionPage.delete(key);
    rasterCeilingByRevisionPage.set(key, ceiling);
    while (rasterCeilingByRevisionPage.size > PDF_RASTER_CEILING_CACHE_LIMIT) {
        const oldestKey = rasterCeilingByRevisionPage.keys().next().value;
        if (oldestKey === undefined) break;
        rasterCeilingByRevisionPage.delete(oldestKey);
    }
}

export function resetNativePdfRasterCeilingCacheForTests() {
    rasterCeilingByRevisionPage.clear();
}

function parsePositiveFiniteNumber(value: string | undefined) {
    const parsed = Number.parseFloat(value ?? '');
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function withPopplerEnv(
    env: NodeJS.ProcessEnv | undefined,
    options: IRunNativeToolCommandOptions,
): IRunNativeToolCommandOptions {
    return env ? {
        ...options,
        env,
    } : options;
}

function normalizePageCount(pdfInfoOutput: string) {
    const count = Number.parseInt(PAGE_COUNT_RE.exec(pdfInfoOutput)?.[1] ?? '', 10);
    if (!Number.isSafeInteger(count) || count < 1) {
        throw new Error('Unable to determine PDF page count for native preview');
    }
    if (count > PDF_NATIVE_MAX_PAGE_COUNT) {
        throw new RangeError(`Native PDF preview supports at most ${PDF_NATIVE_MAX_PAGE_COUNT.toLocaleString()} pages`);
    }
    return count;
}

function parseDefaultPageSize(pdfInfoOutput: string): IPdfNativePageSize | null {
    const match = DEFAULT_PAGE_SIZE_RE.exec(pdfInfoOutput);
    const width = parsePositiveFiniteNumber(match?.[1]);
    const height = parsePositiveFiniteNumber(match?.[2]);
    return width && height ? {
        width,
        height,
    } : null;
}

export function parsePdfInfoPageSizes(
    pdfInfoOutput: string,
    pageCount: number,
    fallbackPageSize?: IPdfNativePageSize | null,
): IPdfNativePageSize[] {
    const sizes = Array.from({ length: pageCount }, () => (
        fallbackPageSize
            ? { ...fallbackPageSize }
            : null
    ));

    PAGE_SIZE_RE.lastIndex = 0;
    for (const match of pdfInfoOutput.matchAll(PAGE_SIZE_RE)) {
        const pageNumber = Number.parseInt(match[1] ?? '', 10);
        const width = parsePositiveFiniteNumber(match[2]);
        const height = parsePositiveFiniteNumber(match[3]);
        if (
            !Number.isSafeInteger(pageNumber)
            || pageNumber < 1
            || pageNumber > pageCount
            || !width
            || !height
        ) {
            continue;
        }
        sizes[pageNumber - 1] = {
            width,
            height,
        };
    }

    const firstResolvedSize = sizes.find((size): size is IPdfNativePageSize => Boolean(size));
    if (!firstResolvedSize) {
        throw new Error('Unable to determine PDF page dimensions for native preview');
    }

    return sizes.map(size => size ?? { ...firstResolvedSize });
}

function normalizeRightAngleRotation(rawRotation: string | undefined): 0 | 90 | 180 | 270 {
    const parsed = Number.parseInt(rawRotation ?? '0', 10);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error('Unable to determine PDF opening page rotation');
    }
    const normalized = ((parsed % 360) + 360) % 360;
    if (normalized !== 0 && normalized !== 90 && normalized !== 180 && normalized !== 270) {
        throw new Error('PDF opening page has an unsupported rotation');
    }
    return normalized;
}

export function parsePdfOpeningGeometryMetadata(
    pdfInfoOutput: string,
    identity: Pick<IPdfOpeningGeometry, 'size' | 'modifiedAt'>,
): IPdfOpeningGeometry {
    const pageCount = normalizePageCount(pdfInfoOutput);
    PAGE_SIZE_RE.lastIndex = 0;
    const firstPageSizeMatch = Array.from(pdfInfoOutput.matchAll(PAGE_SIZE_RE))
        .find(match => Number.parseInt(match[1] ?? '', 10) === 1);
    const fallbackPageSize = parseDefaultPageSize(pdfInfoOutput);
    const width = parsePositiveFiniteNumber(firstPageSizeMatch?.[2]) ?? fallbackPageSize?.width ?? null;
    const height = parsePositiveFiniteNumber(firstPageSizeMatch?.[3]) ?? fallbackPageSize?.height ?? null;
    if (width === null || height === null) {
        throw new Error('Unable to determine PDF opening page dimensions');
    }
    PAGE_ROTATION_RE.lastIndex = 0;
    const firstPageRotationMatch = Array.from(pdfInfoOutput.matchAll(PAGE_ROTATION_RE))
        .find(match => Number.parseInt(match[1] ?? '', 10) === 1);
    return {
        pageNumber: 1,
        pageCount,
        width,
        height,
        rotation: normalizeRightAngleRotation(firstPageRotationMatch?.[2]),
        size: identity.size,
        modifiedAt: identity.modifiedAt,
    };
}

function normalizePreviewTargetWidth(options: IPdfNativePagePreviewOptions | undefined) {
    const rawTargetWidth = options?.targetWidthPx ?? PDF_RENDER_DEFAULT_TARGET_WIDTH_PX;
    if (!Number.isFinite(rawTargetWidth)) {
        return PDF_RENDER_DEFAULT_TARGET_WIDTH_PX;
    }
    return Math.min(
        PDF_RENDER_MAX_TARGET_WIDTH_PX,
        Math.max(PDF_RENDER_MIN_TARGET_WIDTH_PX, Math.trunc(rawTargetWidth)),
    );
}

function parsePageGeometry(pdfInfoOutput: string, pageNumber: number): IPdfPageGeometry | null {
    PAGE_SIZE_RE.lastIndex = 0;
    const pageSizeMatch = Array.from(pdfInfoOutput.matchAll(PAGE_SIZE_RE))
        .find(match => Number.parseInt(match[1] ?? '', 10) === pageNumber);
    const width = parsePositiveFiniteNumber(pageSizeMatch?.[2]);
    const height = parsePositiveFiniteNumber(pageSizeMatch?.[3]);
    PAGE_ROTATION_RE.lastIndex = 0;
    const rotationMatch = Array.from(pdfInfoOutput.matchAll(PAGE_ROTATION_RE))
        .find(match => Number.parseInt(match[1] ?? '', 10) === pageNumber);
    if (width === null || height === null || rotationMatch === undefined) {
        return null;
    }
    try {
        return {
            width,
            height,
            rotation: normalizeRightAngleRotation(rotationMatch[2]),
        };
    } catch {
        return null;
    }
}

function parseSingletonFullPageRasterCeiling(
    pdfImagesOutput: string,
    pageNumber: number,
    pageGeometry: IPdfPageGeometry,
) {
    // pdfimages reports raster metadata, not the complete display list. This
    // deliberately narrow geometry heuristic fails open on image ambiguity,
    // but it cannot prove that a page has no visible vector overlay.
    if (pageGeometry.rotation !== 0) {
        return null;
    }
    const rows = pdfImagesOutput
        .split(/\r?\n/u)
        .map(line => line.trim().split(/\s+/u))
        .filter(parts => Number.isSafeInteger(Number.parseInt(parts[0] ?? '', 10)));
    if (rows.length !== 1) {
        return null;
    }
    const row = rows[0]!;
    const detectedPage = Number.parseInt(row[0] ?? '', 10);
    const type = row[2];
    const widthPx = Number.parseInt(row[3] ?? '', 10);
    const heightPx = Number.parseInt(row[4] ?? '', 10);
    const xPpi = Number.parseInt(row[12] ?? '', 10);
    const yPpi = Number.parseInt(row[13] ?? '', 10);
    if (
        row.length < 14
        || detectedPage !== pageNumber
        || type !== 'image'
        || !Number.isSafeInteger(widthPx)
        || widthPx < 1
        || !Number.isSafeInteger(heightPx)
        || heightPx < 1
        || !Number.isSafeInteger(xPpi)
        || xPpi < 1
        || !Number.isSafeInteger(yPpi)
        || yPpi < 1
    ) {
        return null;
    }
    const displayedWidthPoints = widthPx * 72 / xPpi;
    const displayedHeightPoints = heightPx * 72 / yPpi;
    const widthCoverage = displayedWidthPoints / pageGeometry.width;
    const heightCoverage = displayedHeightPoints / pageGeometry.height;
    if (
        Math.abs(widthCoverage - 1) > PDF_RASTER_PAGE_COVERAGE_TOLERANCE
        || Math.abs(heightCoverage - 1) > PDF_RASTER_PAGE_COVERAGE_TOLERANCE
    ) {
        return null;
    }
    return Math.min(
        PDF_RENDER_MAX_TARGET_WIDTH_PX,
        Math.max(PDF_RENDER_MIN_TARGET_WIDTH_PX, widthPx),
    );
}

function normalizePreviewRequestId(options: IPdfNativePagePreviewOptions | undefined) {
    const requestId = options?.previewRequestId?.trim();
    return requestId && requestId.length > 0 ? requestId : null;
}

function getPreviewAborterKey(senderId: number, requestId: string) {
    return `${senderId}:${requestId}`;
}

function getPreviewRequestOwnerId(context: IDocumentsSenderIdContext) {
    return context.senderId ?? -1;
}

function readPngDimensions(bytes: Uint8Array) {
    if (
        bytes.byteLength < 24
        || bytes[0] !== 0x89
        || bytes[1] !== 0x50
        || bytes[2] !== 0x4e
        || bytes[3] !== 0x47
        || bytes[12] !== 0x49
        || bytes[13] !== 0x48
        || bytes[14] !== 0x44
        || bytes[15] !== 0x52
    ) {
        throw new Error('Native PDF preview renderer produced an invalid PNG');
    }

    return {
        width: bytes.buffer instanceof ArrayBuffer
            ? new DataView(bytes.buffer, bytes.byteOffset + 16, 8).getUint32(0)
            : Buffer.from(bytes).readUInt32BE(16),
        height: bytes.buffer instanceof ArrayBuffer
            ? new DataView(bytes.buffer, bytes.byteOffset + 16, 8).getUint32(4)
            : Buffer.from(bytes).readUInt32BE(20),
    };
}

async function resolvePdfPath(context: IDocumentsSenderIdContext, filePath: unknown) {
    return resolveExistingReadablePdfPath(filePath, context.senderId);
}

async function resolvePdfOpeningGeometryPath(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
) {
    try {
        return await resolvePdfPath(context, filePath);
    } catch (error) {
        if (
            typeof filePath !== 'string'
            || !(await getRecentFiles()).some(file => file.originalPath === filePath)
        ) {
            throw error;
        }

        // Recent-file metadata preflight runs before the open command mints its
        // normal path capability. Grant only a path which is still present in
        // the main-process Recent ledger, scoped to this renderer owner.
        const owner = context.sender ?? context.senderId;
        const trustedRecentPath = allowOpenPath(filePath, owner);
        if (trustedRecentPath === null) {
            throw error;
        }
        // Opening geometry is intentionally discovered from the immutable
        // original source before a working copy exists. The Recent ledger plus
        // the owner-scoped open capability is the authority boundary here;
        // the normal readable-path resolver only accepts managed temp paths
        // and therefore cannot resolve this pre-open source.
        return trustedRecentPath;
    }
}

function abortPreviewController(controller: AbortController, reason: string) {
    if (!controller.signal.aborted) {
        controller.abort(new Error(reason));
    }
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

async function detectPdfPageRasterCeiling(options: {
    cancelGroup: string;
    env: NodeJS.ProcessEnv | undefined;
    page: number;
    pdfImagesPath: string | undefined;
    pdfInfoPath: string;
    physicalPath: string;
    signal: AbortSignal;
}) {
    if (!options.pdfImagesPath) {
        return null;
    }
    try {
        const identity = await stat(options.physicalPath);
        throwIfAborted(options.signal);
        const cacheKey = [
            options.physicalPath,
            identity.size,
            identity.mtimeMs,
            options.page,
        ].join('\0');
        const cached = rasterCeilingByRevisionPage.get(cacheKey);
        if (cached !== undefined || rasterCeilingByRevisionPage.has(cacheKey)) {
            return cached ?? null;
        }
        const pageArg = String(options.page);
        const geometryResult = await runNativeToolCommand(
            options.pdfInfoPath,
            [
                '-box',
                '-f',
                pageArg,
                '-l',
                pageArg,
                options.physicalPath,
            ],
            withPopplerEnv(options.env, {
                timeoutMs: PDFINFO_TIMEOUT_MS,
                maxStdoutBytes: PDFINFO_BASE_STDOUT_BYTES,
                rejectOnStdoutTruncation: true,
                commandLabel: 'pdfinfo-raster-ceiling',
                signal: options.signal,
                cancelGroup: options.cancelGroup,
            }),
        );
        throwIfAborted(options.signal);
        const geometry = parsePageGeometry(geometryResult.stdout, options.page);
        if (!geometry) {
            cacheRasterCeiling(cacheKey, null);
            return null;
        }
        const imageResult = await runNativeToolCommand(
            options.pdfImagesPath,
            [
                '-f',
                pageArg,
                '-l',
                pageArg,
                '-list',
                options.physicalPath,
            ],
            withPopplerEnv(options.env, {
                timeoutMs: PDFIMAGES_TIMEOUT_MS,
                maxStdoutBytes: PDFIMAGES_PAGE_STDOUT_BYTES,
                rejectOnStdoutTruncation: true,
                commandLabel: 'pdfimages-raster-ceiling',
                signal: options.signal,
                cancelGroup: options.cancelGroup,
            }),
        );
        throwIfAborted(options.signal);
        const ceiling = parseSingletonFullPageRasterCeiling(imageResult.stdout, options.page, geometry);
        cacheRasterCeiling(cacheKey, ceiling);
        return ceiling;
    } catch (error) {
        throwIfAborted(options.signal);
        logger.debug(`Native PDF raster-ceiling probe failed open: ${String(error)}`);
        return null;
    }
}

function cancelActivePreviewRequest(senderId: number, requestId: string, reason: string) {
    const abort = activePreviewAborters.get(getPreviewAborterKey(senderId, requestId));
    if (!abort) {
        return false;
    }
    abort(reason);
    return true;
}

function registerNativePdfSenderCleanup(
    sender: Electron.WebContents | undefined,
    abort: (reason: string) => void,
    navigationReason = 'Renderer navigation canceled native PDF preview',
) {
    if (!sender) {
        return () => undefined;
    }
    if (sender.isDestroyed()) {
        abort('Renderer lifecycle ended');
        return () => undefined;
    }

    const handleDestroyed = () => abort('Renderer lifecycle ended');
    const handleRenderProcessGone = () => abort('Renderer lifecycle ended');
    const handleNavigation = (
        _event: Electron.Event,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        if (isMainFrame && !isInPlace) {
            abort(navigationReason);
        }
    };

    sender.once('destroyed', handleDestroyed);
    sender.once('render-process-gone', handleRenderProcessGone);
    sender.on('did-start-navigation', handleNavigation);

    return () => {
        sender.removeListener('destroyed', handleDestroyed);
        sender.removeListener('render-process-gone', handleRenderProcessGone);
        sender.removeListener('did-start-navigation', handleNavigation);
    };
}

export async function handlePdfNativePageSizes(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
): Promise<IPdfNativePageSize[]> {
    const resolvedPath = await resolvePdfPath(context, filePath);
    const originalBackedRead = resolveOriginalBackedReadTransport(resolvedPath, context.senderId);
    const tools = getPdfNativeToolPaths();
    const env = buildPopplerEnv(tools);
    const abortController = new AbortController();
    let cancelGroup = '';
    const cancelPageSizes = (reason: string) => {
        abortPreviewController(abortController, reason);
        if (cancelGroup) {
            cancelNativeCommandGroup(cancelGroup);
        }
    };
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId: context.senderId,
        workingCopyPath: resolvedPath,
        cancel: cancelPageSizes,
    });
    cancelGroup = `pdf-native-page-sizes:${mainOperation.id}`;
    const handleMainAbort = () => {
        cancelPageSizes('Native PDF page-size discovery canceled');
    };
    const unregisterSenderCleanup = registerNativePdfSenderCleanup(
        context.sender,
        cancelPageSizes,
        'Renderer navigation canceled native PDF page-size discovery',
    );
    mainOperation.signal.addEventListener('abort', handleMainAbort, { once: true });

    const readPageSizes = async (physicalPath: string) => {
        const overview = await runNativeToolCommand(
            tools.pdfinfo,
            [physicalPath],
            withPopplerEnv(env, {
                timeoutMs: PDFINFO_TIMEOUT_MS,
                maxStdoutBytes: PDFINFO_BASE_STDOUT_BYTES,
                commandLabel: 'pdfinfo',
                signal: abortController.signal,
                cancelGroup,
            }),
        );
        throwIfAborted(abortController.signal);
        const pageCount = normalizePageCount(overview.stdout);
        const fallbackPageSize = parseDefaultPageSize(overview.stdout);

        if (pageCount > PDFINFO_DETAILED_PAGE_LIMIT) {
            return parsePdfInfoPageSizes(overview.stdout, pageCount, fallbackPageSize);
        }

        const detailed = await runNativeToolCommand(
            tools.pdfinfo,
            [
                '-box',
                '-f',
                '1',
                '-l',
                String(pageCount),
                physicalPath,
            ],
            withPopplerEnv(env, {
                timeoutMs: PDFINFO_TIMEOUT_MS,
                maxStdoutBytes: Math.max(PDFINFO_BASE_STDOUT_BYTES, pageCount * PDFINFO_PER_PAGE_STDOUT_BYTES),
                rejectOnStdoutTruncation: true,
                commandLabel: 'pdfinfo',
                signal: abortController.signal,
                cancelGroup,
            }),
        );
        throwIfAborted(abortController.signal);

        return parsePdfInfoPageSizes(
            detailed.stdout,
            pageCount,
            parseDefaultPageSize(detailed.stdout) ?? fallbackPageSize,
        );
    };

    try {
        return originalBackedRead
            ? await originalBackedRead.read(readPageSizes)
            : await readPageSizes(resolvedPath);
    } finally {
        mainOperation.signal.removeEventListener('abort', handleMainAbort);
        unregisterSenderCleanup();
        mainOperation.complete();
    }
}

async function readPdfOpeningGeometryIdentity(resolvedPath: string) {
    try {
        const fileStat = await stat(resolvedPath);
        return {
            size: fileStat.size,
            modifiedAt: Math.trunc(fileStat.mtimeMs),
        };
    } catch (error) {
        if (isMissingPdfOpeningGeometrySource(error)) {
            return null;
        }
        throw error;
    }
}

function isMissingPdfOpeningGeometrySource(error: unknown) {
    return isErrnoException(error)
        && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function isUnregisteredManagedWorkingCopy(filePath: unknown, senderId?: number) {
    if (typeof filePath !== 'string') {
        return false;
    }
    const normalizedPath = filePath.trim();
    return isWorkingCopyDirectoryName(basename(dirname(normalizedPath)))
        && getWorkingCopyBackingEntry(normalizedPath, senderId) === null;
}

export async function handlePdfOpeningGeometry(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
): Promise<IPdfOpeningGeometry | null> {
    if (isUnregisteredManagedWorkingCopy(filePath, context.senderId)) {
        return null;
    }
    let resolvedPath: string;
    try {
        resolvedPath = await resolvePdfOpeningGeometryPath(context, filePath);
    } catch (error) {
        if (isUnregisteredManagedWorkingCopy(filePath, context.senderId)) {
            return null;
        }
        throw error;
    }
    const originalBackedRead = resolveOriginalBackedReadTransport(resolvedPath, context.senderId);
    const identityBefore = originalBackedRead?.identity
        ?? await readPdfOpeningGeometryIdentity(resolvedPath);
    if (identityBefore === null) {
        return null;
    }
    const tools = getPdfNativeToolPaths();
    const env = buildPopplerEnv(tools);
    const abortController = new AbortController();
    let cancelGroup = '';
    const cancelOpeningGeometry = (reason: string) => {
        abortPreviewController(abortController, reason);
        if (cancelGroup) {
            cancelNativeCommandGroup(cancelGroup);
        }
    };
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId: context.senderId,
        workingCopyPath: resolvedPath,
        cancel: cancelOpeningGeometry,
    });
    cancelGroup = `pdf-opening-geometry:${mainOperation.id}`;
    const handleMainAbort = () => {
        cancelOpeningGeometry('PDF opening geometry discovery canceled');
    };
    const unregisterSenderCleanup = registerNativePdfSenderCleanup(
        context.sender,
        cancelOpeningGeometry,
        'Renderer navigation canceled PDF opening geometry discovery',
    );
    mainOperation.signal.addEventListener('abort', handleMainAbort, {once: true});

    try {
        const readGeometry = (physicalPath: string) => runNativeToolCommand(
            tools.pdfinfo,
            [
                '-box',
                '-f',
                '1',
                '-l',
                '1',
                physicalPath,
            ],
            withPopplerEnv(env, {
                timeoutMs: PDFINFO_TIMEOUT_MS,
                maxStdoutBytes: PDFINFO_BASE_STDOUT_BYTES,
                rejectOnStdoutTruncation: true,
                commandLabel: 'pdfinfo-opening-geometry',
                signal: abortController.signal,
                cancelGroup,
            }),
        );
        const result = originalBackedRead
            ? await originalBackedRead.read(readGeometry)
            : await readGeometry(resolvedPath);
        throwIfAborted(abortController.signal);
        const identityAfter = originalBackedRead?.identity
            ?? await readPdfOpeningGeometryIdentity(resolvedPath);
        if (identityAfter === null) {
            return null;
        }
        if (
            identityAfter.size !== identityBefore.size
            || identityAfter.modifiedAt !== identityBefore.modifiedAt
        ) {
            throw new Error('PDF changed while opening geometry was being discovered');
        }
        return parsePdfOpeningGeometryMetadata(result.stdout, identityAfter);
    } finally {
        mainOperation.signal.removeEventListener('abort', handleMainAbort);
        unregisterSenderCleanup();
        mainOperation.complete();
    }
}

export function handleCancelPdfNativePagePreview(
    context: IDocumentsSenderIdContext,
    requestId: string,
): Promise<{ canceled: boolean }> {
    const canceled = cancelActivePreviewRequest(
        getPreviewRequestOwnerId(context),
        requestId,
        'Native PDF preview canceled',
    );
    return Promise.resolve({canceled});
}

async function runPdfNativePagePreview(
    context: IDocumentsSenderIdContext,
    resolvedPath: string,
    pageNumber: unknown,
    options?: IPdfNativePagePreviewOptions,
): Promise<IPdfNativePagePreview> {
    const page = Number(pageNumber);
    if (!Number.isSafeInteger(page) || page < 1) {
        throw new Error(`Invalid PDF page number: ${String(pageNumber)}`);
    }

    const requestedTargetWidthPx = normalizePreviewTargetWidth(options);
    const previewRequestId = normalizePreviewRequestId(options);
    const ownerId = getPreviewRequestOwnerId(context);
    const originalBackedRead = resolveOriginalBackedReadTransport(resolvedPath, context.senderId);
    const tools = getPdfNativeToolPaths();
    const env = buildPopplerEnv(tools);
    const abortController = new AbortController();
    let cancelGroup = '';
    const cancelPreview = (reason: string) => {
        abortPreviewController(abortController, reason);
        if (cancelGroup) {
            cancelNativeCommandGroup(cancelGroup);
        }
    };
    if (previewRequestId) {
        cancelActivePreviewRequest(ownerId, previewRequestId, 'Native PDF preview request superseded');
        activePreviewAborters.set(
            getPreviewAborterKey(ownerId, previewRequestId),
            cancelPreview,
        );
    }
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId: context.senderId,
        workingCopyPath: resolvedPath,
        cancel: (reason) => {
            cancelPreview(reason);
        },
    });
    cancelGroup = `pdf-native-preview:${mainOperation.id}`;
    const handleMainAbort = () => {
        cancelPreview('Native PDF preview canceled');
    };
    const unregisterSenderCleanup = registerNativePdfSenderCleanup(context.sender, (reason) => {
        cancelPreview(reason);
    });
    mainOperation.signal.addEventListener('abort', handleMainAbort, { once: true });
    let tempDir: string | null = null;
    let resourceLease: IJobBrokerLease | null = null;
    const requestStartedAt = performance.now();
    let requestOutcome = 'failed';

    try {
        logger.debug(`Native PDF preview admission started: ${JSON.stringify({
            ownerId,
            page,
            previewRequestId,
            targetWidthPx: requestedTargetWidthPx,
        })}`);
        resourceLease = await acquireNativePdfPreviewAdmission({
            acquire: request => mainJobBroker.acquire(request),
            ownerSignal: abortController.signal,
            request: {
                ownerId: String(ownerId),
                kind: 'native-pdf-preview',
                priority: 'visible',
                admissionClass: 'interactive',
                perOwnerLimit: 2,
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: Math.max(16 * 1024 * 1024, PDF_RENDER_MAX_OUTPUT_BYTES * 2),
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
            },
        });
        logger.debug(`Native PDF preview admission granted: ${JSON.stringify({
            ownerId,
            page,
            previewRequestId,
            targetWidthPx: requestedTargetWidthPx,
            waitMs: Math.round((performance.now() - requestStartedAt) * 10) / 10,
        })}`);
        tempDir = await mkdtemp(join(tmpdir(), 'evb-pdf-native-preview-'));
        const outputPrefix = join(tempDir, 'page');
        const outputPath = `${outputPrefix}.png`;
        let rasterWidthCeilingPx: number | null = null;
        const renderPage = async (physicalPath: string) => {
            rasterWidthCeilingPx = await detectPdfPageRasterCeiling({
                cancelGroup,
                env,
                page,
                pdfImagesPath: tools.pdfimages,
                pdfInfoPath: tools.pdfinfo,
                physicalPath,
                signal: abortController.signal,
            });
            const targetWidthPx = rasterWidthCeilingPx === null
                ? requestedTargetWidthPx
                : Math.min(requestedTargetWidthPx, rasterWidthCeilingPx);
            logger.debug(`Native PDF preview render started: ${JSON.stringify({
                ownerId,
                page,
                previewRequestId,
                requestedTargetWidthPx,
                rasterWidthCeilingPx,
                targetWidthPx,
            })}`);
            await runNativeToolCommand(
                tools.pdftoppm,
                [
                    '-png',
                    '-singlefile',
                    '-scale-to-x',
                    String(targetWidthPx),
                    '-scale-to-y',
                    '-1',
                    '-f',
                    String(page),
                    '-l',
                    String(page),
                    physicalPath,
                    outputPrefix,
                ],
                withPopplerEnv(env, {
                    timeoutMs: PDF_RENDER_TIMEOUT_MS,
                    maxStdoutBytes: 64 * 1024,
                    maxStderrBytes: 512 * 1024,
                    commandLabel: 'pdftoppm',
                    signal: abortController.signal,
                    cancelGroup,
                }),
            );
        };
        if (originalBackedRead) {
            await originalBackedRead.read(renderPage);
        } else {
            await renderPage(resolvedPath);
        }
        const outputStat = await stat(outputPath);
        if (outputStat.size > PDF_RENDER_MAX_OUTPUT_BYTES) {
            throw new RangeError('Native PDF preview exceeds the 64 MiB output limit');
        }
        const bytes = new Uint8Array(await readFile(outputPath));
        const {
            width,
            height,
        } = readPngDimensions(bytes);
        if (width * height > PDF_RENDER_MAX_OUTPUT_PIXELS) {
            throw new RangeError('Native PDF preview exceeds the 64-megapixel surface limit');
        }
        requestOutcome = 'completed';
        return {
            bytes,
            width,
            height,
            ...(rasterWidthCeilingPx === null ? {} : {rasterWidthCeilingPx}),
        };
    } finally {
        if (previewRequestId) {
            const aborterKey = getPreviewAborterKey(ownerId, previewRequestId);
            if (activePreviewAborters.get(aborterKey) === cancelPreview) {
                activePreviewAborters.delete(aborterKey);
            }
        }
        if (tempDir !== null) {
            await rm(tempDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined);
        }
        mainOperation.signal.removeEventListener('abort', handleMainAbort);
        unregisterSenderCleanup();
        mainOperation.complete();
        resourceLease?.release();
        logger.debug(`Native PDF preview request finished: ${JSON.stringify({
            ownerId,
            page,
            previewRequestId,
            targetWidthPx: requestedTargetWidthPx,
            outcome: abortController.signal.aborted ? 'canceled' : requestOutcome,
            totalMs: Math.round((performance.now() - requestStartedAt) * 10) / 10,
        })}`);
    }
}

export async function handlePdfNativePagePreview(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    pageNumber: unknown,
    options?: IPdfNativePagePreviewOptions,
): Promise<IPdfNativePagePreview> {
    const resolvedPath = await resolvePdfPath(context, filePath);
    const page = Number(pageNumber);
    const targetWidthPx = normalizePreviewTargetWidth(options);
    const requestId = normalizePreviewRequestId(options) ?? 'unscoped';
    const dedupeKey = `${getPreviewRequestOwnerId(context)}\0${requestId}\0${resolvedPath}\0${page}\0${targetWidthPx}`;
    const existing = activePreviewPromises.get(dedupeKey);
    if (existing) {
        return existing;
    }
    const previewPromise = runPdfNativePagePreview(context, resolvedPath, pageNumber, options);
    activePreviewPromises.set(dedupeKey, previewPromise);
    return previewPromise.finally(() => {
        if (activePreviewPromises.get(dedupeKey) === previewPromise) {
            activePreviewPromises.delete(dedupeKey);
        }
    });
}
