import {
    PDFDict,
    PDFDocument,
    PDFName,
} from 'pdf-lib';
import type {
    IDocumentsFileCapability,
    IPdfConformanceProfile,
    IPdfValidationResult,
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platform-api';
import type { IRecentFile } from '@contracts/shared';
import {
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
    getWindowWithPickers,
    isDjvuFileName,
    isPdfFileName,
    toArrayBuffer,
} from '@app/platform/browser-api/common';
import type { IFilePickerAcceptType } from '@app/platform/browser-api/common';

interface IPickedBrowserFile {
    file: File;
    handle?: FileSystemFileHandle | null;
}

interface ICreateBrowserDocumentsFileCapabilityOptions {clearSearchCaches: () => void;}

const pdfBinaryDecoder = new TextDecoder('latin1');

function createDefaultPdfConformanceProfile(): IPdfConformanceProfile {
    return {
        isSigned: false,
        isEncrypted: false,
        isTagged: false,
        pdfaLevel: null,
        hasAcroForm: false,
        hasXfa: false,
        canIncrementalSave: true,
        saveRestrictions: [],
    };
}

function decodePdfBinary(bytes: Uint8Array) {
    return pdfBinaryDecoder.decode(bytes);
}

function detectBrowserPdfaLevel(bytes: Uint8Array) {
    const text = decodePdfBinary(bytes);
    const partMatch = text.match(/<pdfaid:part>\s*([^<\s]+)\s*<\/pdfaid:part>/iu);
    if (!partMatch?.[1]) {
        return null;
    }

    const conformanceMatch = text.match(/<pdfaid:conformance>\s*([^<\s]+)\s*<\/pdfaid:conformance>/iu);
    const conformance = conformanceMatch?.[1]?.trim().toUpperCase() ?? '';
    return `PDF/A-${partMatch[1].trim()}${conformance}`;
}

function detectBrowserSignatureMarkers(bytes: Uint8Array) {
    return /\/(?:ByteRange|FT\s*\/Sig|Type\s*\/Sig)\b/u.test(decodePdfBinary(bytes));
}

function buildBrowserSaveRestrictions(profile: Omit<IPdfConformanceProfile, 'saveRestrictions'>) {
    const restrictions: string[] = [];

    if (profile.isSigned) {
        restrictions.push('signed_original_requires_save_as');
    }
    if (profile.isEncrypted) {
        restrictions.push('encrypted_document_requires_preservation');
    }
    if (profile.hasXfa) {
        restrictions.push('xfa_forms_are_not_supported_for_rewrite');
    }
    if (profile.isTagged) {
        restrictions.push('tagged_pdf_requires_structure_preservation');
    }
    if (profile.pdfaLevel) {
        restrictions.push(`pdfa_preservation_required:${profile.pdfaLevel}`);
    }
    if (!profile.canIncrementalSave) {
        restrictions.push('incremental_save_not_supported');
    }

    return restrictions;
}

async function analyzeBrowserPdfConformance(path: string): Promise<IPdfConformanceProfile> {
    const fallback = createDefaultPdfConformanceProfile();
    const bytes = await browserDocumentStore.read(path);

    try {
        const doc = await PDFDocument.load(bytes, {
            ignoreEncryption: true,
            updateMetadata: false,
        });
        const catalog = doc.catalog;
        const acroForm = catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
        const structTreeRoot = catalog.lookupMaybe(PDFName.of('StructTreeRoot'), PDFDict);
        const hasXfa = acroForm instanceof PDFDict && acroForm.has(PDFName.of('XFA'));
        const baseProfile = {
            isSigned: detectBrowserSignatureMarkers(bytes),
            isEncrypted: doc.isEncrypted,
            isTagged: structTreeRoot instanceof PDFDict,
            pdfaLevel: detectBrowserPdfaLevel(bytes),
            hasAcroForm: acroForm instanceof PDFDict,
            hasXfa,
            canIncrementalSave: !doc.isEncrypted && !hasXfa,
        };

        return {
            ...baseProfile,
            saveRestrictions: buildBrowserSaveRestrictions(baseProfile),
        };
    } catch {
        return {
            ...fallback,
            isSigned: detectBrowserSignatureMarkers(bytes),
            pdfaLevel: detectBrowserPdfaLevel(bytes),
            saveRestrictions: buildBrowserSaveRestrictions({
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
        await PDFDocument.load(data, {
            ignoreEncryption: true,
            updateMetadata: false,
        });
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
}) {
    const pickerWindow = getWindowWithPickers();
    if (pickerWindow?.showOpenFilePicker) {
        try {
            const handles = await pickerWindow.showOpenFilePicker({
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
            }, 0);
        };

        input.type = 'file';
        input.accept = options.accept;
        input.multiple = options.multiple ?? false;
        input.style.display = 'none';
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

async function saveBlobToPickerOrDownload(
    blob: Blob,
    suggestedName: string,
    pickerTypes: IFilePickerAcceptType[],
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

export async function saveBytesToPickerOrDownload(
    bytes: Uint8Array,
    options: {
        suggestedName: string;
        mimeType: string;
        pickerTypes: IFilePickerAcceptType[];
    },
) {
    return saveBlobToPickerOrDownload(
        new Blob([toArrayBuffer(bytes)], { type: options.mimeType }),
        options.suggestedName,
        options.pickerTypes,
    );
}

export async function writeBytesToHandle(
    handle: FileSystemFileHandle,
    data: Uint8Array,
) {
    const writable = await handle.createWritable();
    await writable.write(toArrayBuffer(data));
    await writable.close();
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

    const blob = new Blob([toArrayBuffer(bytes)]);
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
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

async function embedImagePage(
    pdfDocument: PDFDocument,
    fileName: string,
    bytes: Uint8Array,
) {
    const extension = getExtension(fileName);
    if (extension === '.jpg' || extension === '.jpeg') {
        const image = await pdfDocument.embedJpg(bytes);
        const page = pdfDocument.addPage([
            image.width,
            image.height,
        ]);
        page.drawImage(image, {
            x: 0,
            y: 0,
            width: image.width,
            height: image.height,
        });
        return;
    }

    const pngBytes = await normalizeImageBytesToPng(fileName, bytes);
    const image = await pdfDocument.embedPng(pngBytes);
    const page = pdfDocument.addPage([
        image.width,
        image.height,
    ]);
    page.drawImage(image, {
        x: 0,
        y: 0,
        width: image.width,
        height: image.height,
    });
}

export async function createCombinedPdfFromPaths(paths: string[]) {
    const pdfDocument = await PDFDocument.create();

    for (const path of paths) {
        const bytes = await browserDocumentStore.read(path);
        const fileName = getBrowserDocumentFileName(path);
        if (isPdfFileName(fileName)) {
            const sourcePdf = await PDFDocument.load(bytes);
            const copiedPages = await pdfDocument.copyPages(
                sourcePdf,
                sourcePdf.getPageIndices(),
            );
            copiedPages.forEach((page) => pdfDocument.addPage(page));
            continue;
        }

        await embedImagePage(pdfDocument, fileName, bytes);
    }

    return new Uint8Array(await pdfDocument.save());
}

async function openDocumentPaths(paths: string[]) {
    const normalizedPaths = paths
        .filter((path) => typeof path === 'string')
        .map((path) => path.trim())
        .filter((path) => path.length > 0);

    if (normalizedPaths.length === 0) {
        return null;
    }

    const firstPath = normalizedPaths[0]!;
    const firstFileName = getBrowserDocumentFileName(firstPath);
    const djvuPaths = normalizedPaths.filter((path) =>
        isDjvuFileName(getBrowserDocumentFileName(path)),
    );

    if (djvuPaths.length > 0) {
        if (normalizedPaths.length !== 1 || djvuPaths.length !== 1) {
            return null;
        }

        await browserDocumentStore.touchRecentFile(firstPath);
        return {
            kind: 'djvu',
            workingPath: '',
            originalPath: firstPath,
        } satisfies TOpenFileResult;
    }

    if (normalizedPaths.length === 1 && isPdfFileName(firstFileName)) {
        const sourcePath = normalizedPaths[0]!;
        const workingPath =
            await browserDocumentStore.cloneAsWorkingCopy(sourcePath);
        await browserDocumentStore.touchRecentFile(sourcePath);
        return {
            kind: 'pdf',
            workingPath,
            originalPath: sourcePath,
        } satisfies TOpenFileResult;
    }

    const combinedPdf = await createCombinedPdfFromPaths(normalizedPaths);
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
        },
    );
    const workingPath =
        await browserDocumentStore.cloneAsWorkingCopy(originalPath);

    for (const path of normalizedPaths.filter((path) => {
        const name = getBrowserDocumentFileName(path);
        return isPdfFileName(name);
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
    const bytes = await browserDocumentStore.read(workingCopyPath);
    const sourceRef = await browserDocumentStore.getSourceRef(workingCopyPath);
    await browserDocumentStore.write(sourceRef, bytes);
    const saveTarget = await browserDocumentStore.getSaveTarget(sourceRef);

    if (saveTarget.saveHandle) {
        await writeBytesToHandle(saveTarget.saveHandle, bytes);
        await browserDocumentStore.assignSaveTarget(
            sourceRef,
            saveTarget.saveName,
            saveTarget.saveKind,
            saveTarget.saveHandle,
        );
    } else {
        const saveResult = await saveBytesToPickerOrDownload(bytes, {
            suggestedName: ensurePdfExtension(saveTarget.saveName),
            mimeType: 'application/pdf',
            pickerTypes: buildPdfSaveTypes(),
        });

        if (saveResult.canceled) {
            return false;
        }

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

            return openDocumentPaths([sourceRef]);
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
                saveKind: 'generic',
                saveHandle: picked.handle ?? null,
            });
        },
        async openPdfDirect(path) {
            if (!isBrowserDocumentRef(path)) {
                return null;
            }

            return openDocumentPaths([path]);
        },
        async openPdfDirectBatch(paths) {
            return openDocumentPaths(paths);
        },
        async savePdfAs(workingCopyPath) {
            const bytes = await browserDocumentStore.read(workingCopyPath);
            const saveTarget =
                await browserDocumentStore.getSaveTarget(workingCopyPath);
            const suggestedName = ensurePdfExtension(saveTarget.saveName);
            const saveResult = await saveBytesToPickerOrDownload(bytes, {
                suggestedName,
                mimeType: 'application/pdf',
                pickerTypes: buildPdfSaveTypes(),
            });

            if (saveResult.canceled) {
                return null;
            }

            const sourceRef = await browserDocumentStore.createStoredDocument(
                ensurePdfExtension(saveResult.fileName),
                bytes,
                {
                    mimeType: 'application/pdf',
                    saveKind: 'pdf',
                    kind: 'source',
                    saveHandle: saveResult.handle,
                },
            );
            await browserDocumentStore.replaceWorkingCopySource(
                workingCopyPath,
                sourceRef,
                ensurePdfExtension(saveResult.fileName),
                saveResult.handle,
            );
            await browserDocumentStore.touchRecentFile(sourceRef);
            return sourceRef;
        },
        async savePdfDialog(suggestedName) {
            const nextName = ensurePdfExtension(suggestedName);
            const saveResult = await saveBytesToPickerOrDownload(new Uint8Array(), {
                suggestedName: nextName,
                mimeType: 'application/pdf',
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
                    saveHandle: saveResult.handle,
                },
            );
        },
        async saveDocxAs(workingCopyPath) {
            const fallbackName = ensureDocxExtension(
                getBrowserDocumentFileName(workingCopyPath).replace(/\.pdf$/iu, ''),
            );
            const saveResult = await saveBlobToPickerOrDownload(
                new Blob([], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
                fallbackName,
                buildDocxSaveTypes(),
            );
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
                    saveHandle: saveResult.handle,
                },
            );
        },
        async readFile(path) {
            return browserDocumentStore.read(path);
        },
        async statFile(path) {
            return browserDocumentStore.stat(path);
        },
        async readFileRange(path, offset, length) {
            const bytes = await browserDocumentStore.read(path);
            return bytes.slice(offset, offset + length);
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
                });
            }

            return true;
        },
        async createWorkingCopyFromData(fileName, data, originalPath) {
            const sourceRef =
                originalPath && isBrowserDocumentRef(originalPath)
                    ? originalPath
                    : await browserDocumentStore.createStoredDocument(fileName, data, {
                        mimeType: 'application/pdf',
                        saveKind: 'pdf',
                        kind: 'source',
                    });

            if (!originalPath || !isBrowserDocumentRef(originalPath)) {
                await browserDocumentStore.touchRecentFile(sourceRef);
            }

            return browserDocumentStore.createStoredDocument(fileName, data, {
                mimeType: 'application/pdf',
                saveKind: 'pdf',
                kind: 'working',
                sourceRef,
            });
        },
        async createWorkingCopyFromPath(sourcePath) {
            return browserDocumentStore.cloneAsWorkingCopy(sourcePath);
        },
        async saveFile(path) {
            clearSearchCaches();
            return saveWorkingBytesToSource(path);
        },
        async cleanupFile(path) {
            const sourceRef = await browserDocumentStore.getSourceRef(path);
            if (sourceRef !== path) {
                await browserDocumentStore.remove(path);
            }
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
                const recentFiles = browserDocumentStore.getRecentFiles();
                const validatedFiles: IRecentFile[] = [];

                for (const file of recentFiles) {
                    if (await browserDocumentStore.exists(file.originalPath)) {
                        validatedFiles.push(file);
                        continue;
                    }

                    browserDocumentStore.removeRecentFile(file.originalPath);
                }

                return validatedFiles;
            },
            async add(path) {
                await browserDocumentStore.touchRecentFile(path);
            },
            remove(path) {
                browserDocumentStore.removeRecentFile(path);
                return Promise.resolve();
            },
            clear() {
                browserDocumentStore.clearRecentFiles();
                return Promise.resolve();
            },
        },
        getPathForFile(file) {
            return browserDocumentStore.getRefForFile(file);
        },
    };
}
