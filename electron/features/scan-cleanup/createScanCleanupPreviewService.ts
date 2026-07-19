import {
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import {
    isAbsolute,
    join,
} from 'path';
import type {
    IScanCleanupPreviewRequest,
    IScanCleanupPreviewResult,
} from '@contracts/electronApiScanCleanup';
import {
    getScanCleanupPageOverride,
    resolveScanCleanupPageLayout,
} from '@contracts/scanCleanupPageOverrides';
import {getPdfPageCount} from '@electron/pdf/pdfPageCount';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {renderPdfPageToPng} from '@electron/ocr/worker/popplerStage';
import {runScanCleanupSidecar} from '@electron/features/scan-cleanup/worker/runScanCleanupSidecar';
import {resolveScanCleanupPath} from '@electron/features/scan-cleanup/createScanCleanupService';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {createLogger} from '@electron/utils/createLogger';

const PREVIEW_DPI = 150;
const PREVIEW_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const logger = createLogger('scan-cleanup-preview');

interface IRawPreview {
    bytes: Uint8Array;
    width: number;
    height: number;
    totalPages: number;
}

interface IPreviewEntry {
    controller: AbortController;
    generation: number;
    tail: Promise<IScanCleanupPreviewResult>;
}

export interface IScanCleanupPreviewDependencies {
    getPageCount: typeof getPdfPageCount;
    renderPage: typeof renderPdfPageToPng;
    runSidecar: typeof runScanCleanupSidecar;
    resolveBinary: () => string | null;
    getTempDir: () => string;
    getPdftoppmBinary: () => string;
}

const defaultDependencies: IScanCleanupPreviewDependencies = {
    getPageCount: getPdfPageCount,
    renderPage: renderPdfPageToPng,
    runSidecar: runScanCleanupSidecar,
    resolveBinary: resolveScanCleanupPath,
    getTempDir: getAppTempDir,
    getPdftoppmBinary: () => getPdfNativeToolPaths().pdftoppm,
};

function readPngDimensions(bytes: Uint8Array) {
    const signature = [
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
    ];
    if (bytes.byteLength < 24 || !signature.every((value, index) => bytes[index] === value)) {
        throw new Error('Scan cleanup preview produced an invalid PNG');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (width < 1 || height < 1 || width * height > 45_000_000) {
        throw new Error(`Scan cleanup preview PNG dimensions ${width}x${height} exceed limits`);
    }
    return {
        width,
        height,
    };
}

async function readPreviewBytes(path: string) {
    const file = await stat(path);
    if (file.size < 1 || file.size > PREVIEW_MAX_IMAGE_BYTES) {
        throw new Error(`Scan cleanup preview image exceeds ${PREVIEW_MAX_IMAGE_BYTES} bytes`);
    }
    const bytes = new Uint8Array(await readFile(path));
    readPngDimensions(bytes);
    return bytes;
}

async function runPreview(
    request: IScanCleanupPreviewRequest,
    signal: AbortSignal,
    rawCache: Map<string, IRawPreview>,
    dependencies: IScanCleanupPreviewDependencies,
): Promise<IScanCleanupPreviewResult> {
    if (!isAbsolute(request.sourcePdfPath)) throw new Error('Scan cleanup preview requires an absolute source path');
    if (signal.aborted) throw signal.reason;
    const scratch = await mkdtemp(join(dependencies.getTempDir(), 'scan-cleanup-preview-'));
    try {
        const cacheKey = `${request.sourcePdfPath}\u0000${request.pageNumber}`;
        let raw = rawCache.get(cacheKey);
        const inputPath = join(scratch, 'source.png');
        if (!raw) {
            const totalPages = await dependencies.getPageCount(request.sourcePdfPath, {signal});
            if (request.pageNumber > totalPages) throw new Error('Scan cleanup preview page is out of range');
            await dependencies.renderPage(
                {pdftoppmBinary: dependencies.getPdftoppmBinary()},
                (level, message) => logger[level](message),
                request.pageNumber,
                request.sourcePdfPath,
                inputPath,
                PREVIEW_DPI,
                undefined,
                signal,
            );
            const bytes = await readPreviewBytes(inputPath);
            raw = {
                bytes,
                ...readPngDimensions(bytes),
                totalPages,
            };
            rawCache.set(cacheKey, raw);
        } else {
            await writeFile(inputPath, raw.bytes);
        }
        if (signal.aborted) throw signal.reason;
        const binary = dependencies.resolveBinary();
        if (!binary) throw new Error('Scan cleanup native tool is unavailable');
        const outputs = [
            0,
            1,
        ].map(index => ({
            outputPath: join(scratch, `clean-${index}.png`),
            metadataPath: join(scratch, `clean-${index}.json`),
        }));
        const manifestPath = join(scratch, 'manifest.json');
        const pageMetadataPath = join(scratch, 'page.json');
        const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, request.pageNumber);
        await writeFile(manifestPath, JSON.stringify({
            sharedOptions: {},
            pages: [{
                inputPath,
                sourcePageIndex: request.pageNumber - 1,
                pageMetadataPath,
                options: {
                    dpi: PREVIEW_DPI,
                    layout: resolveScanCleanupPageLayout(request.options.layoutMode, pageOverride.layoutOverride),
                    cropContent: request.options.crop,
                    marginsMm: [
                        request.options.marginsMm,
                        request.options.marginsMm,
                        request.options.marginsMm,
                        request.options.marginsMm,
                    ],
                    outputMode: request.options.outputMode,
                    thickness: request.options.thickness,
                    despeckle: request.options.outputMode === 'bw' && request.options.despeckle,
                    matchPageSize: false,
                    pageAlignment: request.options.pageAlignment,
                    rotation: pageOverride.rotation,
                    excluded: pageOverride.excluded,
                    skipBlankPages: request.options.skipBlankPages,
                    experimentalAutoDewarp: request.options.straightenCurvedLines,
                    manualSplitX: pageOverride.manualSplitX,
                },
                outputs,
            }],
        }));
        await dependencies.runSidecar(binary, manifestPath, signal, (level, message) => logger[level](message), () => undefined);
        const cleaned = [] as IScanCleanupPreviewResult['outputs'];
        for (const output of outputs) {
            try {
                cleaned.push({
                    imageData: await readPreviewBytes(output.outputPath),
                    metadata: JSON.parse(await readFile(output.metadataPath, 'utf8')) as IScanCleanupPreviewResult['outputs'][number]['metadata'],
                });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        }
        const pageMetadata = JSON.parse(await readFile(pageMetadataPath, 'utf8')) as IScanCleanupPreviewResult['pageMetadata'];
        return {
            pageNumber: request.pageNumber,
            totalPages: raw.totalPages,
            rawImageData: raw.bytes,
            rawWidth: raw.width,
            rawHeight: raw.height,
            pageMetadata,
            outputs: cleaned,
        };
    } finally {
        await rm(scratch, {
            recursive: true,
            force: true,
        });
    }
}

export interface IScanCleanupPreviewService {
    preview: (request: IScanCleanupPreviewRequest) => Promise<IScanCleanupPreviewResult>;
    cancel: (sourcePdfPath: string) => boolean;
}

export function createScanCleanupPreviewService(
    dependencies: IScanCleanupPreviewDependencies = defaultDependencies,
): IScanCleanupPreviewService {
    const active = new Map<string, IPreviewEntry>();
    const rawCache = new Map<string, IRawPreview>();
    return {
        preview(request) {
            const previous = active.get(request.sourcePdfPath);
            previous?.controller.abort(new DOMException('Superseded scan cleanup preview', 'AbortError'));
            const controller = new AbortController();
            const generation = (previous?.generation ?? 0) + 1;
            const priorTail = previous?.tail.catch(() => undefined) ?? Promise.resolve();
            const tail = priorTail.then(() => runPreview(request, controller.signal, rawCache, dependencies));
            active.set(request.sourcePdfPath, {
                controller,
                generation,
                tail,
            });
            void tail.finally(() => {
                if (active.get(request.sourcePdfPath)?.generation === generation) active.delete(request.sourcePdfPath);
            }).catch(() => undefined);
            return tail;
        },
        cancel(sourcePdfPath) {
            const entry = active.get(sourcePdfPath);
            entry?.controller.abort(new DOMException('Canceled scan cleanup preview', 'AbortError'));
            for (const key of rawCache.keys()) {
                if (key.startsWith(`${sourcePdfPath}\u0000`)) rawCache.delete(key);
            }
            return Boolean(entry);
        },
    };
}
