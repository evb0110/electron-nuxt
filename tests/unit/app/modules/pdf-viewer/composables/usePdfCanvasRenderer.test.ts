import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { AnnotationMode } from '@app/services/pdfjs/runtimeLib';
import { usePdfCanvasRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfCanvasRenderer';
import { cast } from '@tests/helpers/cast';

vi.mock('@app/services/pdfjs/runtimeLib', () => ({ AnnotationMode: {
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

    it('applies the settled-render default canvas pixel budget', async () => {
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

        const renderer = usePdfCanvasRenderer({
            outputScale: 2,
            defaultMaxCanvasPixels: 20_000,
        });
        await renderer.renderCanvas(pdfPage as never, 1);

        expect(canvas.width).toBe(200);
        expect(canvas.height).toBe(100);
        expect(canvas.style.width).toBe('200px');
        expect(canvas.style.height).toBe('100px');
    });

    it('lets explicit render options override the settled default canvas budget', async () => {
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

        const renderer = usePdfCanvasRenderer({
            outputScale: 2,
            defaultMaxCanvasPixels: 80_000,
        });
        await renderer.renderCanvas(pdfPage as never, 1, { maxCanvasPixels: 20_000 });

        expect(canvas.width).toBe(200);
        expect(canvas.height).toBe(100);
    });

    it('replaces the existing page canvas without clearing sibling overlay layers', () => {
        const renderer = usePdfCanvasRenderer({ outputScale: 1 });
        const nextCanvas = {} as HTMLCanvasElement;
        const canvasHost = cast<HTMLElement>({
            prepend: vi.fn(),
            querySelector: vi.fn(() => null),
        });
        const previousCanvas = cast<HTMLCanvasElement>({
            parentElement: canvasHost,
            replaceWith: vi.fn(),
        });
        renderer.mountCanvas(
            canvasHost,
            nextCanvas,
            previousCanvas,
        );

        expect(previousCanvas.replaceWith).toHaveBeenCalledWith(nextCanvas);
        expect(canvasHost.prepend).not.toHaveBeenCalled();
    });

    it('cleans prepared canvases when renderCanvas fails before mounting', async () => {
        const canvas = {
            width: 0,
            height: 0,
            style: {} as CSSStyleDeclaration,
            getContext: vi.fn(() => ({})),
            remove: vi.fn(),
        };
        const annotationCanvas = {
            width: 32,
            height: 16,
            style: {} as CSSStyleDeclaration,
            remove: vi.fn(),
        };
        (globalThis as Record<string, unknown>).document = { createElement: vi.fn(() => canvas) };

        const renderError = new Error('cancelled');
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
            render: vi.fn((context: { annotationCanvasMap: Map<string, HTMLCanvasElement>; }) => {
                context.annotationCanvasMap.set('annotation-1', annotationCanvas as never);
                return {
                    cancel: vi.fn(),
                    promise: Promise.reject(renderError),
                };
            }),
        } as const;

        const renderer = usePdfCanvasRenderer({ outputScale: 1 });

        await expect(renderer.renderCanvas(pdfPage as never, 1)).rejects.toBe(renderError);
        expect(canvas.width).toBe(0);
        expect(canvas.height).toBe(0);
        expect(canvas.remove).toHaveBeenCalled();
        expect(annotationCanvas.width).toBe(0);
        expect(annotationCanvas.height).toBe(0);
        expect(annotationCanvas.remove).toHaveBeenCalled();
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

    it('recomputes the hidden annotation operations filter for changed page state', async () => {
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
        const render = vi.fn((_context: { operationsFilter?: (index: number) => boolean; }) => renderTask);
        const operatorLists = [
            {
                fnArray: [
                    80,
                    999,
                    81,
                    80,
                    999,
                    81,
                ],
                argsArray: [
                    ['keep-me'],
                    [],
                    [],
                    ['12R'],
                    [],
                    [],
                ],
            },
            {
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
            },
        ];
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
            getOperatorList: vi.fn(async () => operatorLists.shift()!),
            render,
        } as const;

        const renderer = usePdfCanvasRenderer({ outputScale: 1 });

        await renderer.renderCanvas(pdfPage as never, 1, { hiddenAnnotationIds: new Set(['12R0']) });
        await renderer.renderCanvas(pdfPage as never, 1, { hiddenAnnotationIds: new Set(['12R']) });

        expect(pdfPage.getOperatorList).toHaveBeenCalledTimes(2);
        expect(render).toHaveBeenCalledTimes(2);
        const firstRenderFilter = render.mock.calls[0]?.[0].operationsFilter;
        const secondRenderFilter = render.mock.calls[1]?.[0].operationsFilter;
        if (!firstRenderFilter || !secondRenderFilter) {
            throw new Error('Expected hidden annotation filters to be defined');
        }
        expect(firstRenderFilter(0)).toBe(true);
        expect(firstRenderFilter(3)).toBe(false);
        expect(secondRenderFilter(0)).toBe(false);
    });
});
