import { PDFDocument } from 'pdf-lib';
import { withTimeout } from 'es-toolkit/promise';
import { loadPdfStructure } from '@contracts/pdf-conformance-load';
import type {
    IDocumentsFileCapability,
    IPdfConformanceProfile,
    IPdfValidationResult,
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platform-api';
import { iterateDecodedTiffFrames } from '@contracts/tiff-decode';
import {
    buildPdfSaveRestrictions,
    createDefaultPdfConformanceProfile,
    detectPdfaLevelFromPdfText,
    hasPdfSignatureMarkersInPdfText,
} from '@contracts/electron-api';
import type { IRecentFile } from '@contracts/shared';
import { normalizeNonEmptyStringPaths } from '@contracts/shared';
import {
    BROWSER_DOCUMENT_CHUNK_SIZE,
    BROWSER_MAX_FULL_READ_BYTES,
    browserDocumentStore,
    getBrowserDocumentFileName,
    isBrowserDocumentRef,
} from '@app/platform/browser-document-store';
import { syncBrowserWindowTitle } from '@app/platform/browser-window-tabs';
import {
    OPEN_IMAGE_ACCEPT,
    OPEN_INPUT_ACCEPT,
    buildDocxSaveTypes,
    buildImagePickerTypes,
    buildOpenPdfPickerTypes,
    buildPdfSaveTypes,
    ensureDocxExtension,
    ensurePdfExtension,
    getExtension,
    createPdfjsDocumentInit,
    getPdfjsLib,
    getWindowWithPickers,
    isDjvuFileName,
    isPdfFileName,
} from '@app/platform/browser-api/common';
import type { IFilePickerAcceptType } from '@app/platform/browser-api/common';
import {
    BROWSER_COMBINE_IMAGE_EXTENSIONS,
    buildBrowserByteLimitError,
    toBrowserOwnedArrayBuffer,
} from '@app/platform/browser-api/browser-platform-helpers';
import {
    BrowserPdfCombineWorkerUnavailableError,
    canUseBrowserPdfCombineWorker,
    cloneCombineWorkerInput,
    runBrowserPdfCombineWorkerRequest,
} from '@app/platform/browser-api/browser-pdf-combine-worker-client';
import { appendPdfImagePage } from '@app/platform/browser-api/pdf-image-pages';
import { yieldToBrowser } from '@app/platform/browser-api/browser-yield';
import { emitBrowserOpenPdfDirectBatchProgress } from '@app/platform/browser-api/documents-menu-capability';
import { browserDjvuCapability } from '@app/platform/browser-api/djvu-capability';
import { stripPdfEncryption } from '@app/utils/pdf-decrypt';

interface IPickedBrowserFile {
    file: File;
    handle?: FileSystemFileHandle | null;
}

interface ICreateBrowserDocumentsFileCapabilityOptions {clearSearchCaches: () => void;}
interface IBrowserBatchOpenProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}
interface IBrowserBatchOpenProgressOptions {
    requestId?: string;
    onProgress?: (progress: IBrowserBatchOpenProgress) => void;
}

const pdfBinaryDecoder = new TextDecoder('latin1');
const PDF_ENCRYPT_SCAN_REGION_BYTES = 32 * 1024;
const BROWSER_EAGER_DECRYPT_BYTES = 64 * 1024 * 1024;
const BROWSER_FULL_CONFORMANCE_ANALYSIS_BYTES = 64 * 1024 * 1024;
const BROWSER_COMBINED_PDF_TOTAL_INPUT_MAX_BYTES = 64 * 1024 * 1024;
const BROWSER_COMBINED_PDF_REWRITE_MAX_BYTES = 32 * 1024 * 1024;
const BROWSER_LARGE_SAVE_HANDLE_HINT = 'Use a browser with local file system access enabled to save large documents.';
const BROWSER_DOWNLOAD_FALLBACK_MAX_BYTES = 64 * 1024 * 1024;
const BROWSER_OPEN_PICKER_MODE_SESSION_KEY = 'evb-viewer:browser:open-picker-mode';
const BROWSER_OPEN_PICKER_MODE_INPUT = 'input';
const BROWSER_FILE_HANDLE_PERMISSION_TIMEOUT_MS = 120_000;
const BROWSER_FILE_HANDLE_WRITE_PHASE_TIMEOUT_MS = 180_000;

type TFileSystemPermissionMode = 'read' | 'readwrite';
type TFileSystemPermissionState = 'granted' | 'denied' | 'prompt';
type TPermissionCapableFileHandle = FileSystemFileHandle & {
    queryPermission?: (descriptor?: { mode?: TFileSystemPermissionMode }) => Promise<TFileSystemPermissionState>;
    requestPermission?: (descriptor?: { mode?: TFileSystemPermissionMode }) => Promise<TFileSystemPermissionState>;
};

function isFileSystemAccessDeniedError(error: unknown) {
    return error instanceof DOMException
        && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
}

function createBrowserFileWriteTimeoutError(phase: string) {
    return new Error(
        `Browser file save did not finish while waiting for ${phase}. `
        + 'If Chrome is showing a file permission prompt, choose Save changes or Cancel and try again.',
    );
}

function createBrowserFileWritePermissionError() {
    return new Error(
        'Browser write permission was not granted for this file. '
        + 'Choose Save changes in the browser prompt, or use Save As to pick a new output file.',
    );
}

function normalizeBrowserFileHandleError(error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
}

async function runBrowserFileHandlePhase<T>(
    phase: string,
    timeoutMs: number,
    operation: () => Promise<T>,
) {
    try {
        return await withTimeout(operation, timeoutMs);
    } catch (error) {
        if (
            error instanceof Error
            && (error.name === 'TimeoutError' || error.constructor.name === 'TimeoutError')
        ) {
            throw createBrowserFileWriteTimeoutError(phase);
        }
        throw error;
    }
}

async function ensureFileHandleWritePermission(handle: FileSystemFileHandle) {
    const permissionHandle = handle as TPermissionCapableFileHandle;
    const descriptor = { mode: 'readwrite' as const };
    const queryPermission = permissionHandle.queryPermission?.bind(permissionHandle);
    const requestPermission = permissionHandle.requestPermission?.bind(permissionHandle);

    const currentPermission = queryPermission
        ? await runBrowserFileHandlePhase(
            'file write permission check',
            BROWSER_FILE_HANDLE_PERMISSION_TIMEOUT_MS,
            () => queryPermission(descriptor),
        )
        : 'granted';
    if (currentPermission === 'granted') {
        return;
    }

    const nextPermission = requestPermission
        ? await runBrowserFileHandlePhase(
            'file write permission',
            BROWSER_FILE_HANDLE_PERMISSION_TIMEOUT_MS,
            () => requestPermission(descriptor),
        )
        : currentPermission;
    if (nextPermission !== 'granted') {
        throw createBrowserFileWritePermissionError();
    }
}

function getBrowserSessionStorage() {
    if (typeof window === 'undefined') {
        return null;
    }

    try {
        return window.sessionStorage;
    } catch {
        return null;
    }
}

function shouldUseFileSystemAccessOpenPicker(
    preferFileSystemAccess: boolean,
    hasOpenPicker: boolean,
) {
    if (!preferFileSystemAccess || !hasOpenPicker) {
        return false;
    }

    return getBrowserSessionStorage()?.getItem(BROWSER_OPEN_PICKER_MODE_SESSION_KEY)
        !== BROWSER_OPEN_PICKER_MODE_INPUT;
}

function rememberInputOpenPickerMode() {
    getBrowserSessionStorage()?.setItem(
        BROWSER_OPEN_PICKER_MODE_SESSION_KEY,
        BROWSER_OPEN_PICKER_MODE_INPUT,
    );
}

function decodePdfBinary(bytes: Uint8Array) {
    return pdfBinaryDecoder.decode(bytes);
}

function containsPdfEncryptMarker(bytes: Uint8Array) {
    return decodePdfBinary(bytes).includes('/Encrypt');
}

function detectBrowserPdfaLevel(bytes: Uint8Array) {
    return detectPdfaLevelFromPdfText(decodePdfBinary(bytes));
}

function detectBrowserSignatureMarkers(bytes: Uint8Array) {
    return hasPdfSignatureMarkersInPdfText(decodePdfBinary(bytes));
}

async function readPdfMarkerRegions(path: string) {
    const { size } = await browserDocumentStore.stat(path);
    const head = await browserDocumentStore.readRange(
        path,
        0,
        Math.min(PDF_ENCRYPT_SCAN_REGION_BYTES, size),
    );
    const tailStart = Math.max(head.byteLength, size - PDF_ENCRYPT_SCAN_REGION_BYTES);
    const tail = tailStart < size
        ? await browserDocumentStore.readRange(path, tailStart, size - tailStart)
        : new Uint8Array();

    return {
        size,
        head,
        tail,
    };
}

function mergePdfMarkerRegions(head: Uint8Array, tail: Uint8Array) {
    const merged = new Uint8Array(head.byteLength + tail.byteLength);
    merged.set(head, 0);
    merged.set(tail, head.byteLength);
    return merged;
}

function buildBrowserLargeJobError(
    label: string,
    maxBytes: number,
    hint?: string,
) {
    return buildBrowserByteLimitError(
        label,
        maxBytes,
        'inputs',
        hint,
    );
}

function buildBrowserLargeDownloadFallbackError(
    label: string,
    maxBytes: number,
) {
    return buildBrowserLargeJobError(label, maxBytes, BROWSER_LARGE_SAVE_HANDLE_HINT);
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

async function ensureBrowserCombinedPdfBudget(paths: string[], maxBytes: number) {
    let totalBytes = 0;

    for (let index = 0; index < paths.length; index += 1) {
        if (index > 0) {
            await yieldToBrowser();
        }

        const { size } = await browserDocumentStore.stat(paths[index]!);
        totalBytes += size;
        if (totalBytes > maxBytes) {
            throw buildBrowserLargeJobError(
                'Combining documents',
                maxBytes,
            );
        }
    }
}

async function ensureBrowserCombinedPdfInputBudget(paths: string[]) {
    await ensureBrowserCombinedPdfBudget(paths, BROWSER_COMBINED_PDF_TOTAL_INPUT_MAX_BYTES);
}

async function ensureBrowserCombinedPdfRewriteBudget(paths: string[]) {
    await ensureBrowserCombinedPdfBudget(paths, BROWSER_COMBINED_PDF_REWRITE_MAX_BYTES);
}

function canCombineBrowserPathsOffThread(paths: string[]) {
    return paths.length > 0 && paths.every((path) => {
        const fileName = getBrowserDocumentFileName(path);
        return isPdfFileName(fileName) || BROWSER_COMBINE_IMAGE_EXTENSIONS.has(getExtension(fileName));
    });
}

async function createBrowserPdfFromDjvuForCombine(path: string) {
    const fileName = getBrowserDocumentFileName(path);
    const outputName = ensurePdfExtension(fileName.replace(/\.[^.]+$/u, ''));
    const outputRef = await browserDocumentStore.createStoredDocument(
        outputName,
        new Uint8Array(),
        {
            mimeType: 'application/pdf',
            saveKind: 'pdf',
            kind: 'output',
            retention: 'transient',
        },
    );
    const result = await browserDjvuCapability.convertToPdf(
        path,
        outputRef,
        {
            subsample: 1,
            preserveBookmarks: true,
        },
    );

    if (!result.success) {
        await browserDocumentStore.remove(outputRef).catch(() => undefined);
        throw new Error(result.error ?? `Failed to convert DjVu file: ${fileName}`);
    }

    return outputRef;
}

async function createBrowserCombineInputPaths(paths: string[]) {
    const convertedRefs: string[] = [];
    const combinePaths: string[] = [];

    try {
        for (let index = 0; index < paths.length; index += 1) {
            if (index > 0) {
                await yieldToBrowser();
            }

            const path = paths[index]!;
            const fileName = getBrowserDocumentFileName(path);
            if (!isDjvuFileName(fileName)) {
                combinePaths.push(path);
                continue;
            }

            const convertedRef = await createBrowserPdfFromDjvuForCombine(path);
            convertedRefs.push(convertedRef);
            combinePaths.push(convertedRef);
        }

        return {
            combinePaths,
            convertedRefs,
        };
    } catch (error) {
        await Promise.allSettled(convertedRefs.map(ref => browserDocumentStore.remove(ref)));
        throw error;
    }
}

async function assertBrowserPathWithinFullReadBudget(
    path: string,
    label: string,
    hint?: string,
) {
    const { size } = await browserDocumentStore.stat(path);
    if (size > BROWSER_MAX_FULL_READ_BYTES) {
        throw buildBrowserLargeJobError(label, BROWSER_MAX_FULL_READ_BYTES, hint);
    }
}

async function analyzeBrowserPdfConformance(path: string): Promise<IPdfConformanceProfile> {
    const fallback = createDefaultPdfConformanceProfile();
    const {
        size,
        head,
        tail,
    } = await readPdfMarkerRegions(path);

    if (size > BROWSER_FULL_CONFORMANCE_ANALYSIS_BYTES) {
        const markers = mergePdfMarkerRegions(head, tail);
        const isEncrypted = containsPdfEncryptMarker(markers);
        const pdfaLevel = detectBrowserPdfaLevel(markers);
        const isSigned = detectBrowserSignatureMarkers(markers);
        const baseProfile = {
            isSigned,
            isEncrypted,
            isTagged: false,
            pdfaLevel,
            hasAcroForm: false,
            hasXfa: false,
            canIncrementalSave: !isEncrypted,
        };

        return {
            ...baseProfile,
            saveRestrictions: buildPdfSaveRestrictions(baseProfile),
        };
    }

    const bytes = await browserDocumentStore.read(path);

    try {
        await yieldToBrowser();
        const {
            doc,
            acroForm,
            structTreeRoot,
            hasXfa,
        } = await loadPdfStructure(bytes);
        const baseProfile = {
            isSigned: detectBrowserSignatureMarkers(bytes),
            isEncrypted: doc.isEncrypted,
            isTagged: structTreeRoot !== null,
            pdfaLevel: detectBrowserPdfaLevel(bytes),
            hasAcroForm: acroForm !== null,
            hasXfa,
            canIncrementalSave: !doc.isEncrypted && !hasXfa,
        };

        return {
            ...baseProfile,
            saveRestrictions: buildPdfSaveRestrictions(baseProfile),
        };
    } catch {
        return {
            ...fallback,
            isSigned: detectBrowserSignatureMarkers(bytes),
            pdfaLevel: detectBrowserPdfaLevel(bytes),
            saveRestrictions: buildPdfSaveRestrictions({
                ...fallback,
                isSigned: detectBrowserSignatureMarkers(bytes),
                pdfaLevel: detectBrowserPdfaLevel(bytes),
            }),
        };
    }
}

async function validateBrowserPdfData(data: Uint8Array): Promise<IPdfValidationResult> {
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        return {
            isValid: false,
            tool: 'browser',
            errors: ['PDF validation failed: empty document data'],
            warnings: [],
        };
    }

    try {
        await yieldToBrowser();
        const pdfjsLib = await getPdfjsLib();
        const loadingTask = pdfjsLib.getDocument(
            createPdfjsDocumentInit(pdfjsLib, data),
        );
        const pdfDocument = await loadingTask.promise;
        await pdfDocument.destroy();
        return {
            isValid: true,
            tool: 'browser',
            errors: [],
            warnings: [],
        };
    } catch (error) {
        return {
            isValid: false,
            tool: 'browser',
            errors: [error instanceof Error ? error.message : 'PDF validation failed'],
            warnings: [],
        };
    }
}

export async function pickFiles(options: {
    accept: string;
    multiple?: boolean;
    pickerTypes?: IFilePickerAcceptType[];
    preferFileSystemAccess?: boolean;
}) {
    const pickerWindow = getWindowWithPickers();
    const showOpenFilePicker = pickerWindow?.showOpenFilePicker?.bind(pickerWindow);
    const preferFileSystemAccess = options.preferFileSystemAccess ?? true;
    if (shouldUseFileSystemAccessOpenPicker(preferFileSystemAccess, Boolean(showOpenFilePicker)) && showOpenFilePicker) {
        try {
            const handles = await showOpenFilePicker({
                multiple: options.multiple ?? false,
                types: options.pickerTypes,
            });

            return await Promise.all(
                handles.map(async (handle) => ({
                    file: await handle.getFile(),
                    handle,
                })),
            );
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                return [];
            }

            if (isFileSystemAccessDeniedError(error)) {
                // Some embedded browsers expose File System Access pickers but
                // deny FileSystemFileHandle.getFile(). Do not chain a hidden
                // input picker in the same gesture; switch future opens to the
                // input path for this browser session instead.
                rememberInputOpenPickerMode();
                return [];
            } else {
                throw error;
            }
        }
    }

    if (typeof document === 'undefined' || typeof window === 'undefined') {
        return [];
    }

    return new Promise<IPickedBrowserFile[]>((resolve) => {
        const input = document.createElement('input');
        let settled = false;

        const cleanup = () => {
            input.remove();
            window.removeEventListener('focus', handleFocus);
        };

        const finish = (files: File[]) => {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            resolve(
                files.map((file) => ({
                    file,
                    handle: null,
                })),
            );
        };

        const handleFocus = () => {
            window.setTimeout(() => {
                if (!settled) {
                    finish([]);
                }
            }, 500);
        };

        input.type = 'file';
        input.accept = options.accept;
        input.multiple = options.multiple ?? false;
        input.style.display = 'none';
        input.addEventListener(
            'cancel',
            () => {
                finish([]);
            },
            { once: true },
        );
        input.addEventListener(
            'change',
            () => {
                finish(Array.from(input.files ?? []));
            },
            { once: true },
        );

        document.body.append(input);
        window.addEventListener('focus', handleFocus, { once: true });
        input.click();
    });
}

async function pickSingleFile(options: {
    accept: string;
    pickerTypes?: IFilePickerAcceptType[];
}) {
    const files = await pickFiles(options);
    return files[0] ?? null;
}

export async function saveBlobToPickerOrDownload(
    blob: Blob,
    suggestedName: string,
    pickerTypes: IFilePickerAcceptType[],
    options: {
        downloadFallbackLabel?: string;
        downloadFallbackMaxBytes?: number;
        canDownloadWithoutHandle?: boolean;
    } = {},
) {
    const pickerWindow = getWindowWithPickers();
    if (pickerWindow?.showSaveFilePicker) {
        try {
            const handle = await pickerWindow.showSaveFilePicker({
                suggestedName,
                types: pickerTypes,
            });

            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            return {
                canceled: false,
                fileName: handle.name || suggestedName,
                handle,
            };
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                return {
                    canceled: true,
                    fileName: suggestedName,
                    handle: null,
                };
            }

            throw error;
        }
    }

    if (typeof document === 'undefined' || typeof URL === 'undefined') {
        return {
            canceled: false,
            fileName: suggestedName,
            handle: null,
        };
    }

    const maxDownloadBytes = options.downloadFallbackMaxBytes ?? BROWSER_DOWNLOAD_FALLBACK_MAX_BYTES;
    if (
        options.canDownloadWithoutHandle === false
        || blob.size > maxDownloadBytes
    ) {
        throw buildBrowserLargeDownloadFallbackError(
            options.downloadFallbackLabel ?? 'Saving documents',
            maxDownloadBytes,
        );
    }

    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = suggestedName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 1_000);

    return {
        canceled: false,
        fileName: suggestedName,
        handle: null,
    };
}

export async function pickSaveTarget(options: {
    suggestedName: string;
    pickerTypes: IFilePickerAcceptType[];
}) {
    const pickerWindow = getWindowWithPickers();
    if (!pickerWindow?.showSaveFilePicker) {
        return {
            canceled: false,
            fileName: options.suggestedName,
            handle: null,
        };
    }

    try {
        const handle = await pickerWindow.showSaveFilePicker({
            suggestedName: options.suggestedName,
            types: options.pickerTypes,
        });

        return {
            canceled: false,
            fileName: handle.name || options.suggestedName,
            handle,
        };
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
            return {
                canceled: true,
                fileName: options.suggestedName,
                handle: null,
            };
        }

        throw error;
    }
}

export async function saveBytesToPickerOrDownload(
    bytes: Uint8Array,
    options: {
        suggestedName: string;
        mimeType: string;
        pickerTypes: IFilePickerAcceptType[];
        downloadFallbackLabel?: string;
        downloadFallbackMaxBytes?: number;
        canDownloadWithoutHandle?: boolean;
    },
) {
    return saveBlobToPickerOrDownload(
        new Blob([toBrowserOwnedArrayBuffer(bytes)], { type: options.mimeType }),
        options.suggestedName,
        options.pickerTypes,
        {
            downloadFallbackLabel: options.downloadFallbackLabel,
            downloadFallbackMaxBytes: options.downloadFallbackMaxBytes,
            canDownloadWithoutHandle: options.canDownloadWithoutHandle,
        },
    );
}

export async function writeBytesToHandle(
    handle: FileSystemFileHandle,
    data: Uint8Array,
) {
    await ensureFileHandleWritePermission(handle);
    const writable = await runBrowserFileHandlePhase(
        'opening file for writing',
        BROWSER_FILE_HANDLE_PERMISSION_TIMEOUT_MS,
        () => handle.createWritable(),
    );
    let writeError: unknown = null;
    let closeError: unknown = null;

    try {
        await runBrowserFileHandlePhase(
            'writing file bytes',
            BROWSER_FILE_HANDLE_WRITE_PHASE_TIMEOUT_MS,
            () => writable.write(toBrowserOwnedArrayBuffer(data)),
        );
    } catch (error) {
        writeError = error;
    }

    try {
        await runBrowserFileHandlePhase(
            'closing file writer',
            BROWSER_FILE_HANDLE_WRITE_PHASE_TIMEOUT_MS,
            () => writable.close(),
        );
    } catch (error) {
        closeError = error;
    }

    if (writeError) {
        throw normalizeBrowserFileHandleError(writeError);
    }
    if (closeError) {
        throw normalizeBrowserFileHandleError(closeError);
    }
}

async function writeDocumentRefToHandle(
    handle: FileSystemFileHandle,
    ref: TDocumentRef,
) {
    await ensureFileHandleWritePermission(handle);
    const writable = await runBrowserFileHandlePhase(
        'opening file for writing',
        BROWSER_FILE_HANDLE_PERMISSION_TIMEOUT_MS,
        () => handle.createWritable(),
    );
    let writeError: unknown = null;
    let closeError: unknown = null;

    try {
        const { size } = await browserDocumentStore.stat(ref);
        for (let offset = 0; offset < size; offset += BROWSER_DOCUMENT_CHUNK_SIZE) {
            const chunk = await browserDocumentStore.readRange(
                ref,
                offset,
                Math.min(BROWSER_DOCUMENT_CHUNK_SIZE, size - offset),
            );
            await runBrowserFileHandlePhase(
                'writing file chunk',
                BROWSER_FILE_HANDLE_WRITE_PHASE_TIMEOUT_MS,
                () => writable.write(toBrowserOwnedArrayBuffer(chunk)),
            );
            if (offset > 0) {
                await yieldToBrowser();
            }
        }
    } catch (error) {
        writeError = error;
    }

    try {
        await runBrowserFileHandlePhase(
            'closing file writer',
            BROWSER_FILE_HANDLE_WRITE_PHASE_TIMEOUT_MS,
            () => writable.close(),
        );
    } catch (error) {
        closeError = error;
    }

    if (writeError) {
        throw normalizeBrowserFileHandleError(writeError);
    }
    if (closeError) {
        throw normalizeBrowserFileHandleError(closeError);
    }
}

async function normalizeImageBytesToPng(fileName: string, bytes: Uint8Array) {
    const extension = getExtension(fileName);
    if (extension === '.png') {
        return bytes;
    }

    if (typeof document === 'undefined' || typeof URL === 'undefined') {
        throw new Error(
            `Image format is not available in the current browser runtime: ${fileName}`,
        );
    }

    const blob = new Blob([toBrowserOwnedArrayBuffer(bytes)]);
    const objectUrl = URL.createObjectURL(blob);

    try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
            const nextImage = new Image();
            nextImage.onload = () => resolve(nextImage);
            nextImage.onerror = () =>
                reject(new Error(`Failed to load image: ${fileName}`));
            nextImage.src = objectUrl;
        });

        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('Canvas 2D context is unavailable');
        }

        context.drawImage(image, 0, 0);
        return await canvasToPngBytes(canvas);
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

function createClampedImageData(rgba: Uint8Array, width: number, height: number) {
    if (typeof ImageData === 'undefined') {
        throw new Error('ImageData is unavailable in the current browser runtime');
    }

    const clamped = new Uint8ClampedArray(rgba.byteLength);
    clamped.set(rgba);
    return new ImageData(clamped, width, height);
}

async function canvasToPngBytes(canvas: HTMLCanvasElement) {
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((nextBlob) => {
            if (!nextBlob) {
                reject(new Error('Failed to convert image to PNG'));
                return;
            }

            resolve(nextBlob);
        }, 'image/png');
    });

    return new Uint8Array(await pngBlob.arrayBuffer());
}

async function encodeRgbaToPngBytes(
    width: number,
    height: number,
    rgba: Uint8Array,
) {
    if (typeof document === 'undefined') {
        throw new Error('Canvas 2D context is unavailable');
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Canvas 2D context is unavailable');
    }

    context.putImageData(createClampedImageData(rgba, width, height), 0, 0);
    return canvasToPngBytes(canvas);
}

async function embedTiffPages(
    pdfDocument: PDFDocument,
    fileName: string,
    bytes: Uint8Array,
) {
    let addedPages = 0;

    for (const {
        width,
        height,
        rgba,
    } of iterateDecodedTiffFrames(bytes)) {
        const pngBytes = await encodeRgbaToPngBytes(width, height, rgba);
        const image = await pdfDocument.embedPng(pngBytes);
        appendPdfImagePage(pdfDocument, image);
        addedPages += 1;
    }

    if (addedPages === 0) {
        throw new Error(`Failed to decode TIFF image: ${fileName}`);
    }
}

async function embedImagePage(
    pdfDocument: PDFDocument,
    fileName: string,
    bytes: Uint8Array,
) {
    const extension = getExtension(fileName);
    if (extension === '.tif' || extension === '.tiff') {
        await embedTiffPages(pdfDocument, fileName, bytes);
        return;
    }

    if (extension === '.jpg' || extension === '.jpeg') {
        const image = await pdfDocument.embedJpg(bytes);
        appendPdfImagePage(pdfDocument, image);
        return;
    }

    const pngBytes = await normalizeImageBytesToPng(fileName, bytes);
    const image = await pdfDocument.embedPng(pngBytes);
    appendPdfImagePage(pdfDocument, image);
}

export async function createCombinedPdfFromPaths(
    paths: string[],
    progressOptions?: IBrowserBatchOpenProgressOptions,
) {
    await ensureBrowserCombinedPdfInputBudget(paths);
    const {
        combinePaths,
        convertedRefs,
    } = await createBrowserCombineInputPaths(paths);
    try {
        return await createCombinedPdfFromPreparedPaths(combinePaths, progressOptions);
    } finally {
        if (convertedRefs.length > 0) {
            await Promise.allSettled(convertedRefs.map(ref => browserDocumentStore.remove(ref)));
        }
    }
}

async function createCombinedPdfFromPreparedPaths(
    paths: string[],
    progressOptions?: IBrowserBatchOpenProgressOptions,
) {
    await ensureBrowserCombinedPdfRewriteBudget(paths);
    const startedAt = Date.now();
    const totalPaths = paths.length;

    if (canCombineBrowserPathsOffThread(paths) && canUseBrowserPdfCombineWorker()) {
        const inputs = [];

        for (let index = 0; index < paths.length; index += 1) {
            if (index > 0) {
                await yieldToBrowser();
            }

            const path = paths[index]!;
            const data = await browserDocumentStore.read(path);
            inputs.push(cloneCombineWorkerInput(
                getBrowserDocumentFileName(path),
                data,
            ));
            emitBatchOpenProgress(progressOptions, index + 1, totalPaths, startedAt);
        }

        try {
            const result = await runBrowserPdfCombineWorkerRequest('combinePdfs', { inputs });
            emitBatchOpenProgress(progressOptions, totalPaths, totalPaths, startedAt);
            return result.data;
        } catch (error) {
            if (
                !(error instanceof BrowserPdfCombineWorkerUnavailableError)
                && !(
                    error instanceof Error
                    && (
                        error.message === 'ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_IMAGE_RUNTIME'
                        || error.message.startsWith('ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_INPUT:')
                    )
                )
            ) {
                throw error;
            }
        }
    }

    const pdfDocument = await PDFDocument.create();

    for (let index = 0; index < paths.length; index += 1) {
        if (index > 0) {
            await yieldToBrowser();
        }

        const path = paths[index]!;
        const bytes = await browserDocumentStore.read(path);
        const fileName = getBrowserDocumentFileName(path);
        if (isPdfFileName(fileName)) {
            const sourcePdf = await PDFDocument.load(bytes);
            const copiedPages = await pdfDocument.copyPages(
                sourcePdf,
                sourcePdf.getPageIndices(),
            );
            copiedPages.forEach((page) => pdfDocument.addPage(page));
            emitBatchOpenProgress(progressOptions, index + 1, totalPaths, startedAt);
            continue;
        }

        await embedImagePage(pdfDocument, fileName, bytes);
        emitBatchOpenProgress(progressOptions, index + 1, totalPaths, startedAt);
    }

    await yieldToBrowser();
    return new Uint8Array(await pdfDocument.save());
}

async function decryptBrowserWorkingCopy(workingPath: string): Promise<void> {
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
        // Decryption failed — keep the original encrypted working copy
    }
}

async function createBrowserWorkingCopyFromBytes(options: {
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

async function openDocumentPaths(
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

async function saveWorkingBytesToSource(workingCopyPath: TDocumentRef) {
    const sourceRef = await browserDocumentStore.getSourceRef(workingCopyPath);
    const saveTarget = await browserDocumentStore.getSaveTarget(sourceRef);

    if (saveTarget.saveHandle) {
        await writeDocumentRefToHandle(saveTarget.saveHandle, workingCopyPath);
        const { size } = await browserDocumentStore.stat(workingCopyPath);
        await browserDocumentStore.replaceWithHandleBackedDocument(sourceRef, {
            fileSize: size,
            saveHandle: saveTarget.saveHandle,
            saveName: saveTarget.saveName,
        });
        await browserDocumentStore.assignSaveTarget(
            sourceRef,
            saveTarget.saveName,
            saveTarget.saveKind,
            saveTarget.saveHandle,
        );
    } else {
        await assertBrowserPathWithinFullReadBudget(
            workingCopyPath,
            'Saving documents',
            BROWSER_LARGE_SAVE_HANDLE_HINT,
        );
        const bytes = await browserDocumentStore.read(workingCopyPath);
        const saveResult = await saveBytesToPickerOrDownload(bytes, {
            suggestedName: ensurePdfExtension(saveTarget.saveName),
            mimeType: 'application/pdf',
            pickerTypes: buildPdfSaveTypes(),
            downloadFallbackLabel: 'Saving documents',
        });

        if (saveResult.canceled) {
            return false;
        }

        await browserDocumentStore.write(sourceRef, bytes);
        await browserDocumentStore.assignSaveTarget(
            sourceRef,
            ensurePdfExtension(saveResult.fileName),
            'pdf',
            saveResult.handle,
        );
    }

    await browserDocumentStore.touchRecentFile(sourceRef);
    return true;
}

export function createBrowserDocumentsFileCapability(
    options: ICreateBrowserDocumentsFileCapabilityOptions,
): IDocumentsFileCapability {
    const { clearSearchCaches } = options;

    async function cleanupTransientOpenRefs(paths: string[]) {
        await Promise.all(paths.map(async (path) => {
            try {
                await browserDocumentStore.remove(path);
            } catch {
                // Cleanup is best effort for failed transient opens.
            }
        }));
    }

    return {
        async openPdfDialog() {
            const pickedFiles = await pickFiles({
                accept: OPEN_INPUT_ACCEPT,
                multiple: false,
                pickerTypes: buildOpenPdfPickerTypes(),
            });
            const picked = pickedFiles[0];
            if (!picked) {
                return null;
            }

            const sourceRef = await browserDocumentStore.registerFile(picked.file, {
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: picked.handle ?? null,
            });

            try {
                return await openDocumentPaths([sourceRef]);
            } catch (error) {
                await cleanupTransientOpenRefs([sourceRef]);
                throw error;
            }
        },
        openFolderDialog() {
            return Promise.resolve(null);
        },
        async openCombineDialog() {
            const pickedFiles = await pickFiles({
                accept: OPEN_INPUT_ACCEPT,
                multiple: true,
                pickerTypes: buildOpenPdfPickerTypes(),
            });
            if (pickedFiles.length === 0) {
                return null;
            }

            const refs: string[] = [];
            for (const picked of pickedFiles) {
                const ref = await browserDocumentStore.registerFile(picked.file, {
                    kind: 'source',
                    retention: 'transient',
                    saveKind: 'generic',
                    saveHandle: null,
                });
                refs.push(ref);
            }

            try {
                return await openDocumentPaths(refs);
            } catch (error) {
                await cleanupTransientOpenRefs(refs);
                throw error;
            }
        },
        async openImageDialog() {
            const picked = await pickSingleFile({
                accept: OPEN_IMAGE_ACCEPT,
                pickerTypes: buildImagePickerTypes(),
            });
            if (!picked) {
                return null;
            }

            return browserDocumentStore.registerFile(picked.file, {
                kind: 'source',
                retention: 'transient',
                saveKind: 'generic',
                saveHandle: picked.handle ?? null,
            });
        },
        async openPdfDirect(path) {
            if (!isBrowserDocumentRef(path)) {
                return null;
            }

            try {
                return await openDocumentPaths([path]);
            } catch (error) {
                if (isFileSystemAccessDeniedError(error)) {
                    return null;
                }

                throw error;
            }
        },
        async openPdfDirectBatch(paths, requestId) {
            return openDocumentPaths(paths, { requestId });
        },
        async savePdfAs(workingCopyPath) {
            const saveTarget =
                await browserDocumentStore.getSaveTarget(workingCopyPath);
            const previousSourceRef =
                await browserDocumentStore.getSourceRef(workingCopyPath);
            const suggestedName = ensurePdfExtension(saveTarget.saveName);
            const saveResult = await pickSaveTarget({
                suggestedName,
                pickerTypes: buildPdfSaveTypes(),
            });

            if (saveResult.canceled) {
                return null;
            }

            const normalizedFileName = ensurePdfExtension(saveResult.fileName);
            let sourceRef: string;

            if (saveResult.handle) {
                await writeDocumentRefToHandle(saveResult.handle, workingCopyPath);
                const { size } = await browserDocumentStore.stat(workingCopyPath);
                sourceRef = await browserDocumentStore.createStoredDocument(
                    normalizedFileName,
                    new Uint8Array(),
                    {
                        mimeType: 'application/pdf',
                        saveKind: 'pdf',
                        kind: 'source',
                        saveHandle: saveResult.handle,
                        storageMode: 'handle',
                    },
                );
                await browserDocumentStore.replaceWithHandleBackedDocument(sourceRef, {
                    fileSize: size,
                    saveHandle: saveResult.handle,
                    saveName: normalizedFileName,
                });
            } else {
                await assertBrowserPathWithinFullReadBudget(
                    workingCopyPath,
                    'Saving documents',
                    BROWSER_LARGE_SAVE_HANDLE_HINT,
                );
                const bytes = await browserDocumentStore.read(workingCopyPath);
                const downloadResult = await saveBytesToPickerOrDownload(bytes, {
                    suggestedName,
                    mimeType: 'application/pdf',
                    pickerTypes: buildPdfSaveTypes(),
                    downloadFallbackLabel: 'Saving documents',
                });

                if (downloadResult.canceled) {
                    return null;
                }

                sourceRef = await browserDocumentStore.createStoredDocument(
                    ensurePdfExtension(downloadResult.fileName),
                    bytes,
                    {
                        mimeType: 'application/pdf',
                        saveKind: 'pdf',
                        kind: 'source',
                        saveHandle: downloadResult.handle,
                    },
                );
            }
            await browserDocumentStore.replaceWorkingCopySource(
                workingCopyPath,
                sourceRef,
                normalizedFileName,
                saveResult.handle,
            );
            await browserDocumentStore.cleanupDetachedDocument(previousSourceRef);
            await browserDocumentStore.touchRecentFile(sourceRef);
            browserDocumentStore.unload(sourceRef);
            return sourceRef;
        },
        async savePdfDialog(suggestedName) {
            const nextName = ensurePdfExtension(suggestedName);
            const saveResult = await pickSaveTarget({
                suggestedName: nextName,
                pickerTypes: buildPdfSaveTypes(),
            });
            if (saveResult.canceled) {
                return null;
            }

            return browserDocumentStore.createStoredDocument(
                ensurePdfExtension(saveResult.fileName),
                new Uint8Array(),
                {
                    mimeType: 'application/pdf',
                    saveKind: 'pdf',
                    kind: 'output',
                    retention: 'transient',
                    saveHandle: saveResult.handle,
                },
            );
        },
        async saveDocxAs(workingCopyPath) {
            const fallbackName = ensureDocxExtension(
                getBrowserDocumentFileName(workingCopyPath).replace(/\.pdf$/iu, ''),
            );
            const saveResult = await pickSaveTarget({
                suggestedName: fallbackName,
                pickerTypes: buildDocxSaveTypes(),
            });
            if (saveResult.canceled) {
                return null;
            }

            return browserDocumentStore.createStoredDocument(
                ensureDocxExtension(saveResult.fileName),
                new Uint8Array(),
                {
                    mimeType:
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    saveKind: 'docx',
                    kind: 'output',
                    retention: 'transient',
                    saveHandle: saveResult.handle,
                },
            );
        },
        async readFile(path) {
            return browserDocumentStore.read(path);
        },
        statFile(path) {
            return browserDocumentStore.stat(path);
        },
        readFileRange(path, offset, length) {
            return browserDocumentStore.readRange(path, offset, length);
        },
        async readTextFile(path) {
            return browserDocumentStore.readText(path);
        },
        async fileExists(path) {
            return browserDocumentStore.exists(path);
        },
        async analyzePdfConformance(path) {
            return analyzeBrowserPdfConformance(path);
        },
        async validatePdfData(data) {
            return validateBrowserPdfData(data);
        },
        openPdfInDefaultAppData() {
            return Promise.resolve({
                success: false,
                error: 'Opening via the default desktop PDF app is unavailable in the browser capability',
            });
        },
        openPdfInDefaultAppPath() {
            return Promise.resolve({
                success: false,
                error: 'Opening via the default desktop PDF app is unavailable in the browser capability',
            });
        },
        printPdfData() {
            return Promise.resolve({
                success: false,
                error: 'Printing via the native desktop dialog is unavailable in the browser capability',
            });
        },
        printPdfPath() {
            return Promise.resolve({
                success: false,
                error: 'Printing via the native desktop dialog is unavailable in the browser capability',
            });
        },
        async writeFile(path, data) {
            clearSearchCaches();
            return browserDocumentStore.write(path, data);
        },
        async writeDocxFile(path, data) {
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
            await browserDocumentStore.write(path, bytes);
            const saveTarget = await browserDocumentStore.getSaveTarget(path);

            if (saveTarget.saveHandle) {
                await writeBytesToHandle(saveTarget.saveHandle, bytes);
            } else {
                await saveBytesToPickerOrDownload(bytes, {
                    suggestedName: ensureDocxExtension(saveTarget.saveName),
                    mimeType:
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    pickerTypes: buildDocxSaveTypes(),
                    downloadFallbackLabel: 'Saving documents',
                });
            }

            return true;
        },
        async createWorkingCopyFromData(fileName, data, originalPath) {
            const decryptedData = isPdfFileName(fileName)
                ? new Uint8Array(await stripPdfEncryption(data))
                : data;

            return createBrowserWorkingCopyFromBytes({
                fileName,
                data: decryptedData,
                mimeType: 'application/pdf',
                sourceRef:
                    originalPath && isBrowserDocumentRef(originalPath)
                        ? originalPath
                        : undefined,
            });
        },
        async createWorkingCopyFromPath(sourcePath, originalPath) {
            const sourceEntry = await browserDocumentStore.requireEntry(sourcePath);
            const sourceRef =
                originalPath && isBrowserDocumentRef(originalPath)
                    ? originalPath
                    : (
                        sourceEntry.kind === 'working'
                            ? sourceEntry.sourceRef
                            : sourceEntry.ref
                    );
            if (sourceEntry.kind !== 'working') {
                const workingPath = await browserDocumentStore.cloneAsWorkingCopy(
                    sourceEntry.ref,
                    sourceEntry.fileName,
                );
                await decryptBrowserWorkingCopy(workingPath);
                browserDocumentStore.unload(sourcePath);
                return workingPath;
            }

            const workingPath = await browserDocumentStore.cloneStoredDocument(
                sourceEntry.ref,
                {
                    fileName: sourceEntry.fileName,
                    kind: 'working',
                    retention: 'transient',
                    sourceRef:
                        sourceRef && isBrowserDocumentRef(sourceRef)
                            ? sourceRef
                            : undefined,
                    saveKind: 'pdf',
                    saveHandle: null,
                },
            );
            await decryptBrowserWorkingCopy(workingPath);

            if (sourceEntry.kind !== 'working') {
                browserDocumentStore.unload(sourcePath);
            }
            return workingPath;
        },
        async saveFile(path) {
            clearSearchCaches();
            return saveWorkingBytesToSource(path);
        },
        async cleanupFile(path) {
            const entry = await browserDocumentStore.ensureEntry(path);
            if (!entry) {
                return;
            }

            const sourceRef = entry.sourceRef ?? path;
            if (sourceRef !== path) {
                await browserDocumentStore.remove(path);
                await browserDocumentStore.cleanupDetachedDocument(sourceRef);
                return;
            }

            await browserDocumentStore.cleanupDetachedDocument(path);
        },
        async cleanupOcrTemp(_path) {},
        setWindowTitle(title) {
            if (typeof document !== 'undefined') {
                document.title = title;
            }
            syncBrowserWindowTitle();
            return Promise.resolve();
        },
        showItemInFolder(_path) {
            return Promise.resolve(false);
        },
        recentFiles: {
            async get() {
                await browserDocumentStore.recoverRecentFilesIfStorageMissing();
                const recentFiles = browserDocumentStore.getRecentFiles();
                const validatedFiles: IRecentFile[] = [];

                for (const file of recentFiles) {
                    const entry = await browserDocumentStore.ensureEntry(file.originalPath);
                    if (entry && entry.retention !== 'transient') {
                        validatedFiles.push(file);
                        continue;
                    }

                    await browserDocumentStore.removeRecentFile(file.originalPath);
                }

                return validatedFiles;
            },
            async remove(path) {
                await browserDocumentStore.removeRecentFile(path);
            },
            async clear() {
                await browserDocumentStore.clearRecentFiles();
            },
        },
        getPathForFile(file) {
            return browserDocumentStore.getRefForFile(file);
        },
    };
}
