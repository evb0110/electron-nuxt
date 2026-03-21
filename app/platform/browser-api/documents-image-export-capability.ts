import UTIF from 'utif';
import type { IImageExportCapability } from '@contracts/platform-api';
import {
    browserDocumentStore,
    getBrowserDocumentFileName,
} from '@app/platform/browser-document-store';
import {
    EXPORT_RENDER_SCALE,
    createPdfjsDocumentInit,
    ensurePdfExtension,
    getPdfjsLib,
    toUint8Array,
} from '@app/platform/browser-api/common';
import { saveBytesToPickerOrDownload } from '@app/platform/browser-api/documents-file-capability';

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

async function renderPdfPages(pdfBytes: Uint8Array, pageNumbers?: number[]) {
    if (typeof document === 'undefined') {
        throw new Error('Canvas rendering is unavailable');
    }

    const pdfjsLib = await getPdfjsLib();
    const loadingTask = pdfjsLib.getDocument(
        createPdfjsDocumentInit(pdfjsLib, pdfBytes),
    );
    const pdfDocument = await loadingTask.promise;
    const targetPages = (
        pageNumbers?.length
            ? pageNumbers
            : Array.from(
                { length: pdfDocument.numPages },
                (_value, index) => index + 1,
            )
    ).filter(
        (pageNumber) => pageNumber >= 1 && pageNumber <= pdfDocument.numPages,
    );
    const renderedPages: Array<{
        pageNumber: number;
        fileName: string;
        pngBytes: Uint8Array;
        rgba: Uint8Array;
        width: number;
        height: number;
    }> = [];

    try {
        for (const pageNumber of targetPages) {
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

            renderedPages.push({
                pageNumber,
                fileName: `page-${String(pageNumber).padStart(3, '0')}.png`,
                pngBytes: new Uint8Array(await pngBlob.arrayBuffer()),
                rgba: new Uint8Array(imageData.data),
                width: canvas.width,
                height: canvas.height,
            });
        }
    } finally {
        await pdfDocument.destroy();
    }

    return renderedPages;
}

function alignOffset(offset: number, alignment: number) {
    if (alignment <= 1) {
        return offset;
    }

    const remainder = offset % alignment;
    return remainder === 0 ? offset : offset + (alignment - remainder);
}

function buildTiffIfd(
    page: {
        width: number;
        height: number;
        dataLength: number;
    },
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

function resolvePageDataOffsets(
    pages: Array<{ dataLength: number }>,
    firstDataOffset: number,
) {
    const offsets: number[] = [];
    let cursor = firstDataOffset;

    for (const page of pages) {
        offsets.push(cursor);
        cursor += page.dataLength;
    }

    return offsets;
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

    let firstDataOffset = 0;
    let header = new Uint8Array();
    let pageOffsets: number[] = [];
    const pageDescriptors = pages.map((page) => ({
        width: page.width,
        height: page.height,
        dataLength: page.rgba.byteLength,
    }));

    for (let attempt = 0; attempt < 4; attempt += 1) {
        pageOffsets = resolvePageDataOffsets(pageDescriptors, firstDataOffset);
        header = toUint8Array(
            UTIF.encode(
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

    pageOffsets = resolvePageDataOffsets(
        pageDescriptors,
        alignOffset(header.length, 8),
    );
    header = toUint8Array(
        UTIF.encode(
            pageDescriptors.map((page, index) =>
                buildTiffIfd(page, pageOffsets[index] ?? 0),
            ),
        ),
    );

    const firstPageDataOffset = alignOffset(header.length, 8);
    const paddingLength = firstPageDataOffset - header.length;
    const parts = [
        header,
        new Uint8Array(Math.max(0, paddingLength)),
        ...pages.map((page) => page.rgba),
    ];

    return mergeUint8Arrays(parts);
}

export function createBrowserImageExportCapability(): IImageExportCapability {
    return {
        async exportPdfToImages(workingCopyPath, pageNumbers) {
            const pdfBytes = await browserDocumentStore.read(workingCopyPath);
            const renderedPages = await renderPdfPages(pdfBytes, pageNumbers);
            const outputRefs: string[] = [];

            try {
                for (const page of renderedPages) {
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
                            saveHandle: saveResult.handle,
                        },
                    );
                    outputRefs.push(outputRef);
                }
            } catch (error) {
                await Promise.allSettled(
                    outputRefs.map(async (outputRef) => {
                        await browserDocumentStore.cleanupDetachedDocument(outputRef);
                    }),
                );
                throw error;
            }

            return {
                success: true,
                outputPaths: outputRefs,
            };
        },
        async exportPdfToMultiPageTiff(workingCopyPath, pageNumbers) {
            const pdfBytes = await browserDocumentStore.read(workingCopyPath);
            const renderedPages = await renderPdfPages(pdfBytes, pageNumbers);
            const tiffBytes = encodeMultiPageTiff(
                renderedPages.map((page) => ({
                    rgba: page.rgba,
                    width: page.width,
                    height: page.height,
                })),
            );
            const outputFileName = ensurePdfExtension(
                getBrowserDocumentFileName(workingCopyPath).replace(/\.pdf$/iu, ''),
            ).replace(/\.pdf$/iu, '.tiff');

            const saveResult = await saveBytesToPickerOrDownload(tiffBytes, {
                suggestedName: outputFileName,
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
                },
            );
            return {
                success: true,
                outputPath: outputRef,
            };
        },
    };
}
