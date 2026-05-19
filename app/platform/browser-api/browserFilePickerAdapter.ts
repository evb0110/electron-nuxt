import { withTimeout } from 'es-toolkit/promise';
import type { TDocumentRef } from '@contracts/platformApi';
import {
    BROWSER_DOCUMENT_CHUNK_SIZE,
    browserDocumentStore,
} from '@app/platform/browserDocumentStore';
import type { IFilePickerAcceptType } from '@app/platform/browser-api/browserFileAccepts';
import { getWindowWithPickers } from '@app/platform/browser-api/browserWindowFilePickers';
import {
    buildBrowserByteLimitError,
    toBrowserOwnedArrayBuffer,
} from '@app/platform/browser-api/browserPlatformHelpers';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';

interface IPickedBrowserFile {
    file: File;
    handle?: FileSystemFileHandle | null;
}

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

let browserLargeSaveHandleHintProvider = () => (
    'Use a browser with local file system access enabled to save large documents.'
);

export function configureBrowserFilePickerMessages(options: { largeSaveHandleHint?: () => string; }) {
    browserLargeSaveHandleHintProvider = options.largeSaveHandleHint ?? browserLargeSaveHandleHintProvider;
}

function getBrowserLargeSaveHandleHint(): string {
    return browserLargeSaveHandleHintProvider();
}

export function isFileSystemAccessDeniedError(error: unknown) {
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

async function abortBrowserFileWritable(
    writable: FileSystemWritableFileStream,
) {
    await runBrowserFileHandlePhase(
        'aborting file writer',
        BROWSER_FILE_HANDLE_WRITE_PHASE_TIMEOUT_MS,
        () => writable.abort(),
    ).catch(() => undefined);
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
    return buildBrowserLargeJobError(label, maxBytes, getBrowserLargeSaveHandleHint());
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
                ...(options.pickerTypes ? { types: options.pickerTypes } : {}),
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
                rememberInputOpenPickerMode();
                return [];
            }
            throw error;
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

export async function pickSingleFile(options: {
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
            try {
                await writable.write(blob);
            } catch (error) {
                await abortBrowserFileWritable(writable);
                throw error;
            }
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
    const fallbackOptions = {
        ...(options.downloadFallbackLabel ? { downloadFallbackLabel: options.downloadFallbackLabel } : {}),
        ...(options.downloadFallbackMaxBytes !== undefined
            ? { downloadFallbackMaxBytes: options.downloadFallbackMaxBytes }
            : {}),
        ...(options.canDownloadWithoutHandle !== undefined
            ? { canDownloadWithoutHandle: options.canDownloadWithoutHandle }
            : {}),
    };

    return saveBlobToPickerOrDownload(
        new Blob([toBrowserOwnedArrayBuffer(bytes)], { type: options.mimeType }),
        options.suggestedName,
        options.pickerTypes,
        fallbackOptions,
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
    let closeError: unknown = null;

    try {
        await runBrowserFileHandlePhase(
            'writing file bytes',
            BROWSER_FILE_HANDLE_WRITE_PHASE_TIMEOUT_MS,
            () => writable.write(toBrowserOwnedArrayBuffer(data)),
        );
    } catch (error) {
        await abortBrowserFileWritable(writable);
        throw normalizeBrowserFileHandleError(error);
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

    if (closeError) {
        throw normalizeBrowserFileHandleError(closeError);
    }
}

export async function writeDocumentRefToHandle(
    handle: FileSystemFileHandle,
    ref: TDocumentRef,
) {
    await ensureFileHandleWritePermission(handle);
    const writable = await runBrowserFileHandlePhase(
        'opening file for writing',
        BROWSER_FILE_HANDLE_PERMISSION_TIMEOUT_MS,
        () => handle.createWritable(),
    );
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
        await abortBrowserFileWritable(writable);
        throw normalizeBrowserFileHandleError(error);
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

    if (closeError) {
        throw normalizeBrowserFileHandleError(closeError);
    }
}
