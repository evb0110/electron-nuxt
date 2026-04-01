import UTIF from 'utif';
import type {PDFDocumentProxy} from 'pdfjs-dist';
import type { IImageExportCapability } from '@contracts/platform-api';
import {
    browserDocumentStore,
    getBrowserDocumentFileName,
} from '@app/platform/browser-document-store';
import {
    EXPORT_RENDER_SCALE,
    createPdfjsDocumentInitFromBrowserDocument,
    ensurePdfExtension,
    getPdfjsLib,
    getWindowWithPickers,
    toUint8Array,
} from '@app/platform/browser-api/common';
import { yieldToBrowser } from '@app/platform/browser-api/browser-yield';
import { saveBytesToPickerOrDownload } from '@app/platform/browser-api/documents-file-capability';

interface IRenderedPdfPage {
    pageNumber: number;
    fileName: string;
    pngBytes: Uint8Array;
    rgba: Uint8Array;
    width: number;
    height: number;
}

interface ITiffPageDescriptor {
    pageNumber: number;
    width: number;
    height: number;
    dataLength: number;
}

interface ISaveTarget {
    canceled: boolean;
    fileName: string;
    handle?: FileSystemFileHandle | null;
}

const BROWSER_INLINE_TIFF_EXPORT_MAX_RGBA_BYTES = 64 * 1024 * 1024;
const TIFF_TYPE_BYTES: Record<number, number> = {
    1: 1,
    2: 1,
    3: 2,
    4: 4,
    5: 8,
    12: 8,
};

interface IUtifBinaryWriter {
    writeUint(buffer: Uint8Array, offset: number, value: number): void;
    writeUshort(buffer: Uint8Array, offset: number, value: number): void;
}

interface IUtifEncoderModule {
    _binBE: IUtifBinaryWriter;
    _writeIFD(
        bin: IUtifBinaryWriter,
        data: Uint8Array,
        offset: number,
        ifd: Record<string, unknown>,
    ): [number, number];
    ttypes: Record<number, number | undefined>;
}

const UTIF_ENCODER = UTIF as typeof UTIF & IUtifEncoderModule;

function mergeUint8Arrays(parts: Uint8Array[]) {
    const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const output = new Uint8Array(totalLength);
    let offset = 0;

    for (const part of parts) {
        output.set(part, offset);
        offset += part.byteLength;
    }

    return output;
}

async function pickSaveTarget(options: {
    suggestedName: string;
    pickerTypes: Array<{
        description?: string;
        accept: Record<string, string[]>;
    }>;
}): Promise<ISaveTarget> {
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

async function renderPdfPage(
    pdfDocument: Pick<PDFDocumentProxy, 'getPage'>,
    pageNumber: number,
): Promise<IRenderedPdfPage> {
    const page = await pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale: EXPORT_RENDER_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Canvas 2D context is unavailable');
    }

    await page.render({
        canvas,
        canvasContext: context,
        viewport,
    }).promise;

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error('Failed to export rendered page'));
                return;
            }

            resolve(blob);
        }, 'image/png');
    });

    try {
        await Promise.resolve(page.cleanup?.());
    } catch {
        // Cleanup is best effort.
    }

    return {
        pageNumber,
        fileName: `page-${String(pageNumber).padStart(3, '0')}.png`,
        pngBytes: new Uint8Array(await pngBlob.arrayBuffer()),
        rgba: new Uint8Array(imageData.data),
        width: canvas.width,
        height: canvas.height,
    };
}

async function collectTiffPageDescriptors(
    pdfDocument: Pick<PDFDocumentProxy, 'getPage'>,
    pageNumbers: number[],
) {
    const descriptors: ITiffPageDescriptor[] = [];

    for (const pageNumber of pageNumbers) {
        const page = await pdfDocument.getPage(pageNumber);
        const viewport = page.getViewport({ scale: EXPORT_RENDER_SCALE });
        descriptors.push({
            pageNumber,
            width: Math.ceil(viewport.width),
            height: Math.ceil(viewport.height),
            dataLength: Math.ceil(viewport.width) * Math.ceil(viewport.height) * 4,
        });

        try {
            await Promise.resolve(page.cleanup?.());
        } catch {
            // Cleanup is best effort.
        }

        if (descriptors.length % 2 === 0) {
            await yieldToBrowser();
        }
    }

    return descriptors;
}

function alignOffset(offset: number, alignment: number) {
    if (alignment <= 1) {
        return offset;
    }

    const remainder = offset % alignment;
    return remainder === 0 ? offset : offset + (alignment - remainder);
}

function buildTiffIfd(
    page: ITiffPageDescriptor,
    dataOffset: number,
) {
    return {
        t256: [page.width],
        t257: [page.height],
        t258: [
            8,
            8,
            8,
            8,
        ],
        t259: [1],
        t262: [2],
        t273: [dataOffset],
        t277: [4],
        t278: [page.height],
        t279: [page.dataLength],
        t282: [1],
        t283: [1],
        t284: [1],
        t286: [0],
        t287: [0],
        t296: [1],
        t305: ['EVB Viewer'],
        t338: [1],
    };
}

function getTiffValueCount(value: unknown): number {
    if (Array.isArray(value)) {
        return value.length;
    }

    if (
        ArrayBuffer.isView(value)
        && 'BYTES_PER_ELEMENT' in value
        && typeof value.BYTES_PER_ELEMENT === 'number'
        && value.BYTES_PER_ELEMENT > 0
    ) {
        return Math.floor(value.byteLength / value.BYTES_PER_ELEMENT);
    }

    return 1;
}

function measureTiffIfdSize(ifd: Record<string, unknown>) {
    const keys = Object.keys(ifd);
    let extraDataLength = 0;

    for (const key of keys) {
        const tag = Number.parseInt(key.slice(1), 10);
        const type = UTIF_ENCODER.ttypes[tag];
        if (!type) {
            throw new Error(`Unsupported TIFF tag type for tag ${tag}`);
        }

        const rawValue = ifd[key];
        const valueLength = type === 2
            ? `${String(Array.isArray(rawValue) ? rawValue[0] ?? '' : rawValue ?? '')}\0`.length
            : getTiffValueCount(rawValue);
        const dataLength = (TIFF_TYPE_BYTES[type] ?? 0) * valueLength;
        if (dataLength > 4) {
            extraDataLength += dataLength + (dataLength & 1);
        }
    }

    return 2 + (keys.length * 12) + 4 + extraDataLength;
}

function encodeTiffIfds(ifds: Array<Record<string, unknown>>) {
    const capacity = ifds.reduce((total, ifd) => total + measureTiffIfdSize(ifd), 8);
    const data = new Uint8Array(capacity);
    const bin = UTIF_ENCODER._binBE;

    data[0] = 77;
    data[1] = 77;
    data[3] = 42;

    let ifdOffset = 8;
    bin.writeUint(data, 4, ifdOffset);

    for (let index = 0; index < ifds.length; index += 1) {
        const [
            nextIfdPointerOffset,
            nextIfdOffset,
        ] = UTIF_ENCODER._writeIFD(bin, data, ifdOffset, ifds[index]!);
        ifdOffset = nextIfdOffset;
        if (index < ifds.length - 1) {
            bin.writeUint(data, nextIfdPointerOffset, ifdOffset);
        }
    }

    return data.slice(0, ifdOffset);
}

function encodeMultiPageTiffHeader(pageDescriptors: ITiffPageDescriptor[]) {
    let firstDataOffset = 0;
    let header = new Uint8Array();

    for (let attempt = 0; attempt < 8; attempt += 1) {
        const pageOffsets = pageDescriptors.map(() => 0);
        let cursor = firstDataOffset;
        for (let index = 0; index < pageDescriptors.length; index += 1) {
            const descriptor = pageDescriptors[index]!;
            pageOffsets[index] = cursor;
            cursor += descriptor.dataLength;
        }

        header = toUint8Array(
            encodeTiffIfds(
                pageDescriptors.map((page, index) =>
                    buildTiffIfd(page, pageOffsets[index] ?? 0),
                ),
            ),
        );

        const nextFirstDataOffset = alignOffset(header.length, 8);
        if (nextFirstDataOffset === firstDataOffset) {
            break;
        }
        firstDataOffset = nextFirstDataOffset;
    }

    const finalFirstDataOffset = alignOffset(header.length, 8);
    const totalByteLength = finalFirstDataOffset + pageDescriptors.reduce(
        (total, descriptor) => total + descriptor.dataLength,
        0,
    );
    if (totalByteLength > 0xFFFFFFFF) {
        throw new Error('Multi-page TIFF export exceeds the Classic TIFF 4GB limit');
    }

    return {
        header,
        firstDataOffset: finalFirstDataOffset,
    };
}

async function encodeTiffToWritable(
    pdfDocument: Pick<PDFDocumentProxy, 'getPage'>,
    pageDescriptors: ITiffPageDescriptor[],
    handle: FileSystemFileHandle,
) {
    const writable = await handle.createWritable();
    try {
        const {
            header,
            firstDataOffset,
        } = encodeMultiPageTiffHeader(pageDescriptors);
        await writable.write(header);
        const paddingLength = firstDataOffset - header.length;
        if (paddingLength > 0) {
            await writable.write(new Uint8Array(paddingLength));
        }

        for (const descriptor of pageDescriptors) {
            const rendered = await renderPdfPage(pdfDocument, descriptor.pageNumber);
            if (rendered.rgba.byteLength !== descriptor.dataLength) {
                throw new Error('Rendered TIFF page size did not match the expected descriptor size');
            }

            await writable.write(toUint8Array(rendered.rgba));
            await yieldToBrowser();
        }

        await writable.close();
        return header.length + Math.max(0, firstDataOffset - header.length) + pageDescriptors.reduce(
            (total, descriptor) => total + descriptor.dataLength,
            0,
        );
    } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
    }
}

async function loadPdfDocument(path: string) {
    const pdfjsLib = await getPdfjsLib();
    const loadingTask = pdfjsLib.getDocument(
        await createPdfjsDocumentInitFromBrowserDocument(pdfjsLib, path),
    );
    const pdfDocument = await loadingTask.promise;
    return {
        pdfDocument,
        destroy: async () => {
            await pdfDocument.destroy();
        },
    };
}

function getTargetPages(pdfDocument: { numPages: number }, pageNumbers?: number[]) {
    const targetPages = (
        pageNumbers?.length
            ? pageNumbers
            : Array.from({ length: pdfDocument.numPages }, (_value, index) => index + 1)
    ).filter((pageNumber) => pageNumber >= 1 && pageNumber <= pdfDocument.numPages);

    return targetPages;
}

export function createBrowserImageExportCapability(): IImageExportCapability {
    return {
        async exportPdfToImages(workingCopyPath, pageNumbers) {
            const pdfDocument = await loadPdfDocument(workingCopyPath);
            const targetPages = getTargetPages(pdfDocument.pdfDocument, pageNumbers);
            const outputRefs: string[] = [];

            try {
                for (let index = 0; index < targetPages.length; index += 1) {
                    const pageNumber = targetPages[index]!;
                    const page = await renderPdfPage(pdfDocument.pdfDocument, pageNumber);
                    const saveResult = await saveBytesToPickerOrDownload(page.pngBytes, {
                        suggestedName: page.fileName,
                        mimeType: 'image/png',
                        pickerTypes: [{
                            description: 'PNG Images',
                            accept: { 'image/png': ['.png'] },
                        }],
                    });
                    if (saveResult.canceled) {
                        await Promise.allSettled(
                            outputRefs.map(async (outputRef) => {
                                await browserDocumentStore.cleanupDetachedDocument(outputRef);
                            }),
                        );
                        return {
                            success: false,
                            canceled: true,
                        };
                    }

                    const outputRef = await browserDocumentStore.createStoredDocument(
                        saveResult.fileName,
                        page.pngBytes,
                        {
                            mimeType: 'image/png',
                            saveKind: 'generic',
                            kind: 'output',
                            retention: 'transient',
                            saveHandle: saveResult.handle ?? null,
                            storageMode: saveResult.handle ? 'handle' : 'inline',
                        },
                    );
                    await browserDocumentStore.touchRecentFile(outputRef);
                    outputRefs.push(outputRef);

                    if (index % 2 === 1) {
                        await yieldToBrowser();
                    }
                }
            } catch (error) {
                await Promise.allSettled(
                    outputRefs.map(async (outputRef) => {
                        await browserDocumentStore.cleanupDetachedDocument(outputRef);
                    }),
                );
                throw error;
            } finally {
                await pdfDocument.destroy();
            }

            return {
                success: true,
                outputPaths: outputRefs,
            };
        },
        async exportPdfToMultiPageTiff(workingCopyPath, pageNumbers) {
            const pdfDocument = await loadPdfDocument(workingCopyPath);
            const targetPages = getTargetPages(pdfDocument.pdfDocument, pageNumbers);
            const outputFileName = ensurePdfExtension(
                getBrowserDocumentFileName(workingCopyPath).replace(/\.pdf$/iu, ''),
            ).replace(/\.pdf$/iu, '.tiff');

            if (targetPages.length === 0) {
                await pdfDocument.destroy();
                return {
                    success: false,
                    canceled: true,
                };
            }

            const descriptors = await collectTiffPageDescriptors(pdfDocument.pdfDocument, targetPages);
            const saveTarget = await pickSaveTarget({
                suggestedName: outputFileName,
                pickerTypes: [{
                    description: 'TIFF Images',
                    accept: { 'image/tiff': [
                        '.tif',
                        '.tiff',
                    ] },
                }],
            });

            if (saveTarget.canceled) {
                await pdfDocument.destroy();
                return {
                    success: false,
                    canceled: true,
                };
            }

            try {
                if (saveTarget.handle) {
                    const fileSize = await encodeTiffToWritable(
                        pdfDocument.pdfDocument,
                        descriptors,
                        saveTarget.handle,
                    );
                    const outputRef = await browserDocumentStore.createStoredDocument(
                        saveTarget.fileName,
                        new Uint8Array(),
                        {
                            mimeType: 'image/tiff',
                            saveKind: 'generic',
                            kind: 'output',
                            retention: 'transient',
                            saveHandle: saveTarget.handle,
                            storageMode: 'handle',
                        },
                    );
                    await browserDocumentStore.replaceWithHandleBackedDocument(outputRef, {
                        fileSize,
                        saveHandle: saveTarget.handle,
                        saveName: saveTarget.fileName,
                    });
                    await browserDocumentStore.touchRecentFile(outputRef);
                    return {
                        success: true,
                        outputPath: outputRef,
                    };
                }

                const estimatedRgbaBytes = descriptors.reduce(
                    (total, descriptor) => total + descriptor.dataLength,
                    0,
                );
                if (estimatedRgbaBytes > BROWSER_INLINE_TIFF_EXPORT_MAX_RGBA_BYTES) {
                    throw new Error(
                        `Multi-page TIFF export without a file handle is disabled for exports larger than ${Math.floor(BROWSER_INLINE_TIFF_EXPORT_MAX_RGBA_BYTES / (1024 * 1024))}MB`,
                    );
                }

                const renderedPages: IRenderedPdfPage[] = [];
                try {
                    for (const pageNumber of targetPages) {
                        renderedPages.push(await renderPdfPage(pdfDocument.pdfDocument, pageNumber));
                        if (renderedPages.length % 2 === 0) {
                            await yieldToBrowser();
                        }
                    }
                } finally {
                    // Nothing to clean up here beyond the document itself.
                }

                const tiffBytes = encodeMultiPageTiff(
                    renderedPages.map((page) => ({
                        rgba: page.rgba,
                        width: page.width,
                        height: page.height,
                    })),
                );

                const saveResult = await saveBytesToPickerOrDownload(tiffBytes, {
                    suggestedName: saveTarget.fileName,
                    mimeType: 'image/tiff',
                    pickerTypes: [{
                        description: 'TIFF Images',
                        accept: { 'image/tiff': [
                            '.tif',
                            '.tiff',
                        ] },
                    }],
                });

                if (saveResult.canceled) {
                    return {
                        success: false,
                        canceled: true,
                    };
                }

                const outputRef = await browserDocumentStore.createStoredDocument(
                    saveResult.fileName,
                    tiffBytes,
                    {
                        mimeType: 'image/tiff',
                        saveKind: 'generic',
                        kind: 'output',
                        retention: 'transient',
                        saveHandle: saveResult.handle ?? null,
                        storageMode: saveResult.handle ? 'handle' : 'inline',
                    },
                );
                await browserDocumentStore.touchRecentFile(outputRef);
                return {
                    success: true,
                    outputPath: outputRef,
                };
            } finally {
                await pdfDocument.destroy();
            }
        },
    };
}

function encodeMultiPageTiff(
    pages: Array<{
        rgba: Uint8Array;
        width: number;
        height: number;
    }>,
) {
    if (pages.length === 0) {
        throw new Error('No pages available for TIFF export');
    }

    const pageDescriptors = pages.map((page, index) => ({
        pageNumber: index + 1,
        width: page.width,
        height: page.height,
        dataLength: page.rgba.byteLength,
    }));
    const {
        header,
        firstDataOffset,
    } = encodeMultiPageTiffHeader(pageDescriptors);
    const parts = [
        header,
        new Uint8Array(Math.max(0, firstDataOffset - header.length)),
        ...pages.map((page) => page.rgba),
    ];

    return mergeUint8Arrays(parts);
}
