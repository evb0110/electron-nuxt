import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
    type IBrowserPrintDocument,
    buildBrowserPrintFrameMarkup,
    buildPrintablePdfData,
    buildPrintSpreadGroups,
    canPrintSourcePdfDirectly,
    parsePrintPageRangeInput,
    renderPdfPagesForBrowserPrint,
    shouldPrintPageMetricsDirectly,
    shouldPrintSourcePdfDirectly,
} from '@app/utils/pdfPrint';

const pdfjsModule = vi.hoisted((): {
    GlobalWorkerOptions: { workerSrc?: string; };
    VerbosityLevel: { ERRORS: number; };
    getDocument: ReturnType<typeof vi.fn>;
} => ({
    GlobalWorkerOptions: {},
    VerbosityLevel: { ERRORS: 0 },
    getDocument: vi.fn(),
}));

vi.mock('pdfjs-dist', () => pdfjsModule);

async function createSourcePdf(pageSizes: Array<[number, number]>) {
    const pdf = await PDFDocument.create();
    for (const [
        index,
        size,
    ] of pageSizes.entries()) {
        const page = pdf.addPage(size);
        page.drawText(`Page ${index + 1}`, {
            x: 12,
            y: Math.max(12, size[1] - 24),
            size: 12,
        });
    }
    return pdf.save();
}

describe('pdfPrint', () => {
    beforeEach(() => {
        delete (pdfjsModule.GlobalWorkerOptions as Partial<typeof pdfjsModule.GlobalWorkerOptions>).workerSrc;
        pdfjsModule.getDocument.mockReset();
    });

    it('parses comma-separated page ranges into unique sorted page numbers', () => {
        expect(parsePrintPageRangeInput('1-3, 7, 10-12, 3', 12)).toEqual([
            1,
            2,
            3,
            7,
            10,
            11,
            12,
        ]);
    });

    it('rejects invalid page ranges', () => {
        expect(parsePrintPageRangeInput('0-3', 12)).toBeNull();
        expect(parsePrintPageRangeInput('4-20', 12)).toBeNull();
        expect(parsePrintPageRangeInput('2,a', 12)).toBeNull();
    });

    it('groups pages into printable spreads for each supported layout', () => {
        expect(buildPrintSpreadGroups([
            1,
            2,
            3,
            4,
        ], 'single')).toEqual([
            [1],
            [2],
            [3],
            [4],
        ]);

        expect(buildPrintSpreadGroups([
            1,
            2,
            3,
            4,
        ], 'facing')).toEqual([
            [
                1,
                2,
            ],
            [
                3,
                4,
            ],
        ]);

        expect(buildPrintSpreadGroups([
            1,
            2,
            3,
            4,
        ], 'facing-first-single')).toEqual([
            [1],
            [
                2,
                3,
            ],
            [4],
        ]);
    });

    it('detects when the original PDF can be handed directly to native print', () => {
        expect(canPrintSourcePdfDirectly({
            viewMode: 'single',
            orientation: 'auto',
        })).toBe(true);

        expect(canPrintSourcePdfDirectly({
            pageNumbers: [1],
            viewMode: 'single',
            orientation: 'auto',
        })).toBe(false);

        expect(canPrintSourcePdfDirectly({
            viewMode: 'facing',
            orientation: 'auto',
        })).toBe(false);
    });

    it('refuses direct source-PDF printing for oversized pages that need office-paper fitting', async () => {
        const sourcePdfData = await createSourcePdf([[
            734.4,
            1113.12,
        ]]);

        await expect(shouldPrintSourcePdfDirectly(sourcePdfData, {
            viewMode: 'single',
            orientation: 'auto',
        })).resolves.toBe(false);
    });

    it('allows direct source-PDF printing for office-paper-sized pages', async () => {
        const sourcePdfData = await createSourcePdf([[
            595.28,
            841.89,
        ]]);

        await expect(shouldPrintSourcePdfDirectly(sourcePdfData, {
            viewMode: 'single',
            orientation: 'auto',
        })).resolves.toBe(true);
    });

    it('can decide direct-print safety from loaded page metrics without reparsing the PDF', () => {
        expect(shouldPrintPageMetricsDirectly([{
            width: 612,
            height: 792,
        }], {
            viewMode: 'single',
            orientation: 'auto',
        })).toBe(true);

        expect(shouldPrintPageMetricsDirectly([{
            width: 734.4,
            height: 1113.12,
        }], {
            viewMode: 'single',
            orientation: 'auto',
        })).toBe(false);
    });

    it('builds a spread-based printable PDF for facing pages', async () => {
        const sourcePdfData = await createSourcePdf([
            [
                100,
                200,
            ],
            [
                120,
                200,
            ],
            [
                90,
                180,
            ],
        ]);

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [
                1,
                2,
                3,
            ],
            viewMode: 'facing',
            orientation: 'auto',
        });

        expect(printablePdfData).not.toBeNull();

        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(printablePdf.getPageCount()).toBe(2);
        expect(printablePdf.getPage(0)?.getSize()).toEqual({
            width: 841.89,
            height: 595.28,
        });
        expect(printablePdf.getPage(1)?.getSize()).toEqual({
            width: 595.28,
            height: 841.89,
        });
    });

    it('honors the requested print orientation', async () => {
        const sourcePdfData = await createSourcePdf([[
            100,
            200,
        ]]);

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [1],
            viewMode: 'single',
            orientation: 'landscape',
        });

        expect(printablePdfData).not.toBeNull();

        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(printablePdf.getPage(0)?.getSize()).toEqual({
            width: 841.89,
            height: 595.28,
        });
    });

    it('normalizes the default single-page print flow onto office-paper sheets', async () => {
        const sourcePdfData = await createSourcePdf([
            [
                595.28,
                841.89,
            ],
            [
                612,
                792,
            ],
        ]);

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            viewMode: 'single',
            orientation: 'auto',
        });

        expect(printablePdfData).not.toBe(sourcePdfData);

        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(printablePdf.getPageCount()).toBe(2);
        expect(printablePdf.getPage(0)?.getSize()).toEqual({
            width: 595.28,
            height: 841.89,
        });
        expect(printablePdf.getPage(1)?.getSize()).toEqual({
            width: 595.28,
            height: 841.89,
        });
    });

    it('fits oversized single-page documents onto office paper before printing', async () => {
        const sourcePdfData = await createSourcePdf([[
            734.4,
            1113.12,
        ]]);

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            viewMode: 'single',
            orientation: 'auto',
        });

        expect(printablePdfData).not.toBe(sourcePdfData);

        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(printablePdf.getPage(0)?.getSize()).toEqual({
            width: 595.28,
            height: 841.89,
        });
    });

    it('fits only the requested pages for default single-page subset printing', async () => {
        const sourcePdfData = await createSourcePdf([
            [
                595.28,
                841.89,
            ],
            [
                612,
                792,
            ],
            [
                612,
                792,
            ],
        ]);

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [
                3,
                1,
            ],
            viewMode: 'single',
            orientation: 'auto',
        });

        expect(printablePdfData).not.toBeNull();

        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(printablePdf.getPageCount()).toBe(2);
        expect(printablePdf.getPage(0)?.getSize()).toEqual({
            width: 595.28,
            height: 841.89,
        });
        expect(printablePdf.getPage(1)?.getSize()).toEqual({
            width: 595.28,
            height: 841.89,
        });
    });

    it('renders one browser-print page per PDF page into the print document', async () => {
        const root = {
            append: vi.fn(),
            replaceChildren: vi.fn(),
        };
        const firstCanvas = {
            height: 0,
            width: 0,
            style: {},
            getContext: vi.fn(),
        };
        const secondCanvas = {
            height: 0,
            width: 0,
            style: {},
            getContext: vi.fn(),
        };
        firstCanvas.getContext.mockReturnValue({ canvas: firstCanvas });
        secondCanvas.getContext.mockReturnValue({ canvas: secondCanvas });
        const createdSections: Array<{
            append: ReturnType<typeof vi.fn>;
            className: string;
            style: Record<string, string>;
        }> = [];
        const createdCanvases = [
            firstCanvas,
            secondCanvas,
        ];
        function createElement(tag: 'canvas' | 'section') {
            if (tag === 'section') {
                const section = {
                    append: vi.fn(),
                    className: '',
                    style: {},
                };
                createdSections.push(section);
                return section;
            }

            const canvas = createdCanvases.shift();
            if (!canvas) {
                throw new Error('Unexpected extra canvas');
            }
            return canvas;
        }

        const targetDocument: IBrowserPrintDocument = {
            createElement,
            querySelector: () => root,
        };
        const firstPage = {
            cleanup: vi.fn(),
            getViewport: vi.fn(({ scale }: { scale: number }) => scale === 1
                ? {
                    width: 100,
                    height: 200,
                }
                : {
                    width: 200,
                    height: 400,
                }),
            render: vi.fn(() => ({ promise: Promise.resolve() })),
        };
        const secondPage = {
            cleanup: vi.fn(),
            getViewport: vi.fn(({ scale }: { scale: number }) => scale === 1
                ? {
                    width: 120,
                    height: 180,
                }
                : {
                    width: 240,
                    height: 360,
                }),
            render: vi.fn(() => ({ promise: Promise.resolve() })),
        };
        const loadingTaskDestroy = vi.fn(async () => {});
        const pdfDocumentDestroy = vi.fn(async () => {});
        const getPage = vi.fn(async (pageNumber: number) => pageNumber === 1 ? firstPage : secondPage);
        pdfjsModule.getDocument.mockReturnValue({
            destroy: loadingTaskDestroy,
            promise: Promise.resolve({
                destroy: pdfDocumentDestroy,
                getPage,
                numPages: 2,
            }),
        });

        await renderPdfPagesForBrowserPrint(targetDocument, Uint8Array.of(1, 2, 3));

        const { getPdfjsWorkerUrl } = await import('@app/utils/viewerAssets');
        expect(pdfjsModule.GlobalWorkerOptions.workerSrc).toBe(getPdfjsWorkerUrl());
        expect(root.replaceChildren).toHaveBeenCalledTimes(1);
        expect(root.append).toHaveBeenCalledTimes(2);
        expect(firstPage.render).toHaveBeenCalledWith(expect.objectContaining({
            canvas: firstCanvas,
            canvasContext: expect.any(Object),
            viewport: {
                width: 200,
                height: 400,
            },
        }));
        expect(secondPage.render).toHaveBeenCalledWith(expect.objectContaining({
            canvas: secondCanvas,
            canvasContext: expect.any(Object),
            viewport: {
                width: 240,
                height: 360,
            },
        }));
        expect(firstCanvas.style).toEqual({
            height: '2.7778in',
            width: '1.3889in',
        });
        expect(secondCanvas.style).toEqual({
            height: '2.5in',
            width: '1.6667in',
        });
        expect(createdSections[0]?.style).toEqual({
            height: '2.7778in',
            width: '1.3889in',
        });
        expect(createdSections[1]?.style).toEqual({
            height: '2.5in',
            width: '1.6667in',
        });
        expect(firstPage.cleanup).toHaveBeenCalledTimes(1);
        expect(secondPage.cleanup).toHaveBeenCalledTimes(1);
        expect(pdfDocumentDestroy).toHaveBeenCalledTimes(1);
        expect(loadingTaskDestroy).toHaveBeenCalledTimes(1);
    });

    it('builds a browser-print frame shell with a dedicated print root', () => {
        expect(buildBrowserPrintFrameMarkup()).toContain('data-browser-print-root');
        expect(buildBrowserPrintFrameMarkup()).toContain('.browser-print-page');
    });
});
