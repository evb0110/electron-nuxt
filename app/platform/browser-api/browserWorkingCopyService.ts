import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platformApi';
import { normalizeNonEmptyStringPaths } from '@contracts/shared';
import {
    BROWSER_MAX_FULL_READ_BYTES,
    browserDocumentStore,
    getBrowserDocumentFileName,
} from '@app/platform/browserDocumentStore';
import {
    ensurePdfExtension,
    isDjvuFileName,
    isPdfFileName,
} from '@app/platform/browser-api/common';
import { buildBrowserByteLimitError } from '@app/platform/browser-api/browserPlatformHelpers';
import {
    createCombinedPdfFromPaths,
    type IBrowserBatchOpenProgressOptions,
} from '@app/platform/browser-api/browserCombineService';
import { containsPdfEncryptMarker } from '@app/platform/browser-api/browserPdfValidation';
import { emitBrowserOpenPdfDirectBatchProgress } from '@app/platform/browser-api/documentsMenuCapability';
import { stripPdfEncryption } from '@app/utils/pdfDecrypt';

const PDF_ENCRYPT_SCAN_REGION_BYTES = 32 * 1024;
const BROWSER_EAGER_DECRYPT_BYTES = 64 * 1024 * 1024;

function buildBrowserLargeJobError(label: string, maxBytes: number) {
    return buildBrowserByteLimitError(
        label,
        maxBytes,
        'inputs',
    );
}

function emitBatchOpenProgress(
    options: IBrowserBatchOpenProgressOptions | undefined,
    processed: number,
    total: number,
    startedAt: number,
) {
    const requestId = options?.requestId?.trim();
    const safeTotal = Math.max(total, 0);
    const safeProcessed = safeTotal > 0
        ? Math.min(Math.max(processed, 0), safeTotal)
        : 0;
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const percent = safeTotal > 0
        ? (safeProcessed / safeTotal) * 100
        : 100;
    const estimatedRemainingMs = safeProcessed > 0 && safeProcessed < safeTotal
        ? Math.max(
            0,
            Math.round((elapsedMs / safeProcessed) * (safeTotal - safeProcessed)),
        )
        : null;
    const progress = {
        processed: safeProcessed,
        total: safeTotal,
        percent,
        elapsedMs,
        estimatedRemainingMs,
    };

    options?.onProgress?.(progress);

    if (!requestId) {
        return;
    }

    emitBrowserOpenPdfDirectBatchProgress({
        requestId,
        ...progress,
    });
}

export async function decryptBrowserWorkingCopy(workingPath: string): Promise<void> {
    try {
        const { size } = await browserDocumentStore.stat(workingPath);
        if (size > BROWSER_EAGER_DECRYPT_BYTES) {
            const head = await browserDocumentStore.readRange(
                workingPath,
                0,
                Math.min(PDF_ENCRYPT_SCAN_REGION_BYTES, size),
            );
            if (!containsPdfEncryptMarker(head)) {
                const tailStart = Math.max(
                    head.byteLength,
                    size - PDF_ENCRYPT_SCAN_REGION_BYTES,
                );
                const tail = tailStart < size
                    ? await browserDocumentStore.readRange(
                        workingPath,
                        tailStart,
                        size - tailStart,
                    )
                    : new Uint8Array();
                if (!containsPdfEncryptMarker(tail)) {
                    return;
                }
            }
        }

        if (size > BROWSER_MAX_FULL_READ_BYTES) {
            throw buildBrowserLargeJobError(
                'Opening encrypted documents',
                BROWSER_MAX_FULL_READ_BYTES,
            );
        }

        const bytes = await browserDocumentStore.read(workingPath);
        const decrypted = await stripPdfEncryption(bytes);
        if (decrypted !== bytes) {
            await browserDocumentStore.write(workingPath, new Uint8Array(decrypted));
        }
    } catch {
        // Decryption failed; keep the original encrypted working copy.
    }
}

export async function createBrowserWorkingCopyFromBytes(options: {
    fileName: string;
    data: Uint8Array;
    mimeType?: string;
    sourceRef?: TDocumentRef;
}) {
    const workingPath = await browserDocumentStore.createStoredDocument(
        options.fileName,
        options.data,
        {
            mimeType: options.mimeType ?? 'application/pdf',
            saveKind: 'pdf',
            kind: 'working',
            sourceRef: options.sourceRef,
        },
    );

    await decryptBrowserWorkingCopy(workingPath);
    return workingPath;
}

export async function openDocumentPaths(
    paths: string[],
    progressOptions?: IBrowserBatchOpenProgressOptions,
) {
    const startedAt = Date.now();
    const normalizedPaths = normalizeNonEmptyStringPaths(paths);

    if (normalizedPaths.length === 0) {
        return null;
    }

    const firstPath = normalizedPaths[0]!;
    const firstFileName = getBrowserDocumentFileName(firstPath);
    const djvuPaths = normalizedPaths.filter((path) =>
        isDjvuFileName(getBrowserDocumentFileName(path)),
    );

    if (djvuPaths.length > 0) {
        if (normalizedPaths.length === 1 && djvuPaths.length === 1) {
            await browserDocumentStore.touchRecentFile(firstPath);
            emitBatchOpenProgress(progressOptions, 1, 1, startedAt);
            return {
                kind: 'djvu',
                workingPath: '',
                originalPath: firstPath,
            } satisfies TOpenFileResult;
        }
    }

    if (normalizedPaths.length === 1 && isPdfFileName(firstFileName)) {
        const sourcePath = normalizedPaths[0]!;
        const { size } = await browserDocumentStore.stat(sourcePath);
        if (size <= BROWSER_MAX_FULL_READ_BYTES) {
            await browserDocumentStore.ensureByteBackedSource(sourcePath);
        }
        const workingPath =
            await browserDocumentStore.cloneAsWorkingCopy(sourcePath);
        await decryptBrowserWorkingCopy(workingPath);
        await browserDocumentStore.touchRecentFile(sourcePath);
        browserDocumentStore.unload(sourcePath);
        emitBatchOpenProgress(progressOptions, 1, 1, startedAt);
        return {
            kind: 'pdf',
            workingPath,
            originalPath: sourcePath,
        } satisfies TOpenFileResult;
    }

    const combinedPdf = await createCombinedPdfFromPaths(
        normalizedPaths,
        progressOptions,
    );
    const generatedName =
        normalizedPaths.length === 1
            ? ensurePdfExtension(firstFileName.replace(/\.[^.]+$/u, ''))
            : ensurePdfExtension(`combined-${Date.now()}`);
    const originalPath = await browserDocumentStore.createStoredDocument(
        generatedName,
        combinedPdf,
        {
            mimeType: 'application/pdf',
            saveKind: 'pdf',
            kind: 'source',
            retention: 'transient',
        },
    );
    const workingPath =
        await browserDocumentStore.cloneAsWorkingCopy(originalPath);
    browserDocumentStore.unload(originalPath);

    for (const path of normalizedPaths.filter((path) => {
        const name = getBrowserDocumentFileName(path);
        return isPdfFileName(name) || isDjvuFileName(name);
    })) {
        await browserDocumentStore.touchRecentFile(path);
    }

    return {
        kind: 'pdf',
        workingPath,
        originalPath,
        isGenerated: true,
    } satisfies TOpenFileResult;
}
