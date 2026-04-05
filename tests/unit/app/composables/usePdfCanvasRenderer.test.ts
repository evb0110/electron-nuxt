import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { AnnotationMode } from '@app/services/pdfjs/runtime-lib';
import { usePdfCanvasRenderer } from '@app/composables/pdf/usePdfCanvasRenderer';

vi.mock('@app/services/pdfjs/runtime-lib', () => ({ AnnotationMode: {
    ENABLE: 1,
    ENABLE_FORMS: 2,
} }));

describe('usePdfCanvasRenderer', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        delete (globalThis as Record<string, unknown>).document;
    });

    it('requests separate annotation canvases for appearance-backed annotations', async () => {
        const canvas = {
            width: 0,
            height: 0,
            style: {} as CSSStyleDeclaration,
            getContext: vi.fn(() => ({})),
            remove: vi.fn(),
        };
        (globalThis as Record<string, unknown>).document = { createElement: vi.fn(() => canvas) };

        const renderTask = {
            cancel: vi.fn(),
            promise: Promise.resolve(),
        };
        const pdfPage = {
            pageNumber: 1,
            getViewport: vi.fn(() => ({
                width: 200,
                height: 100,
                userUnit: 1,
                rawDims: {
                    pageWidth: 200,
                    pageHeight: 100,
                },
            })),
            render: vi.fn(() => renderTask),
        } as const;

        const renderer = usePdfCanvasRenderer({ outputScale: 1 });
        const result = await renderer.renderCanvas(pdfPage as never, 1);

        expect(pdfPage.render).toHaveBeenCalledWith(expect.objectContaining({
            annotationMode: AnnotationMode?.ENABLE_FORMS ?? AnnotationMode?.ENABLE ?? 1,
            annotationCanvasMap: expect.any(Map),
            canvas,
        }));
        expect(result?.annotationCanvasMap).toBeInstanceOf(Map);
    });

    it('filters hidden annotation appearance ops out of the page canvas render', async () => {
        const canvas = {
            width: 0,
            height: 0,
            style: {} as CSSStyleDeclaration,
            getContext: vi.fn(() => ({})),
            remove: vi.fn(),
        };
        (globalThis as Record<string, unknown>).document = { createElement: vi.fn(() => canvas) };

        const renderTask = {
            cancel: vi.fn(),
            promise: Promise.resolve(),
        };
        const render = vi.fn((_context: { operationsFilter?: (index: number) => boolean; }) => {
            return renderTask;
        });
        const pdfPage = {
            pageNumber: 3,
            getViewport: vi.fn(() => ({
                width: 200,
                height: 100,
                userUnit: 1,
                rawDims: {
                    pageWidth: 200,
                    pageHeight: 100,
                },
            })),
            getOperatorList: vi.fn(async () => ({
                fnArray: [
                    80,
                    999,
                    81,
                    80,
                    999,
                    81,
                ],
                argsArray: [
                    ['12R'],
                    [],
                    [],
                    ['keep-me'],
                    [],
                    [],
                ],
            })),
            render,
        } as const;

        const renderer = usePdfCanvasRenderer({ outputScale: 1 });
        await renderer.renderCanvas(pdfPage as never, 1, { hiddenAnnotationIds: new Set(['12R0']) });

        expect(pdfPage.getOperatorList).toHaveBeenCalledWith({ annotationMode: AnnotationMode?.ENABLE_FORMS ?? AnnotationMode?.ENABLE ?? 1 });
        const renderContext = render.mock.calls[0]?.[0];
        expect(renderContext).toBeDefined();
        if (!renderContext?.operationsFilter) {
            throw new Error('Expected operationsFilter to be defined');
        }
        expect(renderContext.operationsFilter(0)).toBe(false);
        expect(renderContext.operationsFilter(1)).toBe(false);
        expect(renderContext.operationsFilter(2)).toBe(false);
        expect(renderContext.operationsFilter(3)).toBe(true);
        expect(renderContext.operationsFilter(4)).toBe(true);
        expect(renderContext.operationsFilter(5)).toBe(true);
    });

    it('reuses the hidden annotation operations filter for repeated renders of the same page state', async () => {
        const canvas = {
            width: 0,
            height: 0,
            style: {} as CSSStyleDeclaration,
            getContext: vi.fn(() => ({})),
            remove: vi.fn(),
        };
        (globalThis as Record<string, unknown>).document = { createElement: vi.fn(() => canvas) };

        const renderTask = {
            cancel: vi.fn(),
            promise: Promise.resolve(),
        };
        const pdfPage = {
            pageNumber: 2,
            getViewport: vi.fn(() => ({
                width: 200,
                height: 100,
                userUnit: 1,
                rawDims: {
                    pageWidth: 200,
                    pageHeight: 100,
                },
            })),
            getOperatorList: vi.fn(async () => ({
                fnArray: [
                    80,
                    999,
                    81,
                ],
                argsArray: [
                    ['12R'],
                    [],
                    [],
                ],
            })),
            render: vi.fn(() => renderTask),
        } as const;

        const renderer = usePdfCanvasRenderer({ outputScale: 1 });

        await renderer.renderCanvas(pdfPage as never, 1, { hiddenAnnotationIds: new Set(['12R0']) });
        await renderer.renderCanvas(pdfPage as never, 1, { hiddenAnnotationIds: new Set(['12R']) });

        expect(pdfPage.getOperatorList).toHaveBeenCalledTimes(1);
        expect(pdfPage.render).toHaveBeenCalledTimes(2);
    });
});
