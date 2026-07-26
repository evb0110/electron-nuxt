import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import type { IShapeAnnotation } from '@app/types/annotations';
import { useAnnotationShapes } from '@app/modules/pdf-viewer/tools/useAnnotationShapes';
import { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import { importEmbeddedShapeAnnotations } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations';
import { readDocumentBytes } from '@app/utils/documentBytes';
import {
    type IManagedEmbeddedPdfShapeProjectionPort,
    useManagedEmbeddedPdfShapes,
} from '@app/modules/pdf-viewer/runtime/annotations/useManagedEmbeddedPdfShapes';
import { invalidateEmbeddedShapeImportCache } from '@app/modules/pdf-viewer/runtime/annotations/embeddedShapeImportCache';
import {
    requireDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';

vi.mock('@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations', async (importOriginal) => {
    const actual = await importOriginal<{importEmbeddedShapeAnnotations: typeof importEmbeddedShapeAnnotations;}>();
    return {
        ...actual,
        importEmbeddedShapeAnnotations: vi.fn(),
    };
});
vi.mock('@app/utils/documentBytes', () => ({readDocumentBytes: vi.fn()}));

afterEach(() => invalidateEmbeddedShapeImportCache());

class FakeNodeList<TElement extends Element> implements NodeListOf<TElement> {
    readonly length: number;

    [index: number]: TElement;

    constructor(private readonly elements: TElement[]) {
        this.length = elements.length;
        elements.forEach((element, index) => {
            this[index] = element;
        });
    }

    item(index: number) {
        const element = this.elements[index];
        if (!element) {
            throw new RangeError(`No fake node at index ${index}`);
        }
        return element;
    }

    forEach(
        callbackfn: (value: TElement, key: number, parent: NodeListOf<TElement>) => void,
        thisArg?: unknown,
    ) {
        this.elements.forEach((element, index) => {
            callbackfn.call(thisArg, element, index, this);
        });
    }

    entries() {
        return this.elements.entries();
    }

    keys() {
        return this.elements.keys();
    }

    values() {
        return this.elements.values();
    }

    [Symbol.iterator]() {
        return this.values();
    }
}

function createFakeNodeList<TElement extends Element>(elements: TElement[]) {
    return new FakeNodeList(elements);
}

function createRenderedViewerContainer(options: {
    hasShapeOverlay?: boolean;
    shapeOverlayAnnotationIds?: string[];
} = {}) {
    const overlayAnnotationIds = options.shapeOverlayAnnotationIds
        ?? (options.hasShapeOverlay ? ['12R'] : []);
    const overlayElements = overlayAnnotationIds.map(id => Object.assign(
        Object.create(null) as Element,
        {
            dataset: { annotationId: id },
            getAttribute: (name: string) => name === 'data-annotation-id' ? id : null,
        },
    ));
    const pageContainer = Object.create(null) as HTMLElement & {
        querySelector: (selector: string) => object | null;
        querySelectorAll: (selector: string) => NodeListOf<Element>;
    };
    pageContainer.querySelector = (selector: string) => {
        if (selector === '.pdf-shape-overlay.has-shapes' && overlayElements.length > 0) {
            return {};
        }
        return null;
    };
    pageContainer.querySelectorAll = (selector: string) => (
        selector === '.pdf-shape-overlay.has-shapes [data-annotation-id]'
            ? createFakeNodeList(overlayElements)
            : createFakeNodeList([])
    );
    return Object.assign(Object.create(null), {
        querySelector: (selector: string) => {
            if (selector === '.page_container--rendered .page_canvas canvas') {
                return {};
            }
            if (selector === '.page_container[data-page="1"] .page_canvas canvas') {
                return {};
            }
            if (selector === '.page_container[data-page="1"]') {
                return pageContainer;
            }
            return null;
        },
        querySelectorAll: () => [],
    }) as HTMLElement;
}

function createEmbeddedInkShape(overrides: Partial<IShapeAnnotation>): IShapeAnnotation {
    return {
        id: 'embedded-ink-1',
        type: 'polyline',
        pageIndex: 0,
        x: 0.1,
        y: 0.2,
        width: 0.15,
        height: 0.15,
        color: DEFAULT_ANNOTATION_SETTINGS.inkColor,
        opacity: DEFAULT_ANNOTATION_SETTINGS.inkOpacity,
        strokeWidth: DEFAULT_ANNOTATION_SETTINGS.inkThickness,
        points: [
            {
                x: 0.1,
                y: 0.2,
            },
            {
                x: 0.15,
                y: 0.25,
            },
            {
                x: 0.25,
                y: 0.35,
            },
        ],
        strokes: [[
            {
                x: 0.1,
                y: 0.2,
            },
            {
                x: 0.15,
                y: 0.25,
            },
            {
                x: 0.25,
                y: 0.35,
            },
        ]],
        source: 'embedded',
        annotationId: '21R',
        stableKey: 'evb-shape:embedded-ink-1',
        pdfSubtype: 'Ink',
        ...overrides,
    };
}

/**
 * Stands in for the canonical projection: it records the intents the composable
 * forwards, and never decides an import mode of its own.
 */
function createManagedShapeStorePort(overrides: Partial<IManagedEmbeddedPdfShapeProjectionPort> = {}): IManagedEmbeddedPdfShapeProjectionPort {
    let baselineReady = false;
    return {
        getAllShapes: () => [],
        getDeletedEmbeddedAnnotationIds: () => [],
        getDeletedEmbeddedShapeStableKeys: () => [],
        importEmbeddedShapes: vi.fn(() => {
            baselineReady = true;
            return {
                mode: 'replace' as const,
                skipRerender: false,
                reason: 'stub-import',
            };
        }),
        resetShapeImportBaseline: vi.fn(() => {
            baselineReady = false;
        }),
        isShapeImportBaselineReady: () => baselineReady,
        preservesShapeImportBaseline: () => baselineReady,
        clearPendingShapeImportAdoption: vi.fn(),
        beginShapeSave: () => ({
            primePersistedShapes: vi.fn(() => true),
            rollback: vi.fn(() => true),
        }),
        ...overrides,
    };
}

function createCanonicalShapeProjection() {
    const application = shallowRef(new AnnotationApplication('canonical-document'));
    const scope = effectScope();
    const shapeComposable = scope.run(() => useAnnotationShapes({
        annotationApplication: application,
        notifyShapeCommentsChanged: () => undefined,
    }))!;
    return {
        application,
        shapeComposable,
    };
}

describe('useManagedEmbeddedPdfShapes', () => {
    it('keeps every source import behind the post-paint boundary', async () => {
        const source = new Uint8Array([1]);
        const importEmbeddedShapesMock = vi.mocked(importEmbeddedShapeAnnotations);
        importEmbeddedShapesMock.mockReset().mockResolvedValue([]);
        const managedShapes = useManagedEmbeddedPdfShapes({
            viewerContainer: ref(createRenderedViewerContainer()),
            workingCopyPath: ref('/tmp/large-demand-driven.pdf'),
            sourcePdfData: ref<Uint8Array | null>(source),
            documentRevisionToken: ref(null),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            bufferPages: ref(0),
            shapeComposable: createManagedShapeStorePort(),
            deletedEmbeddedAnnotationIds: ref(new Set<string>()),
            logger: {
                debug: vi.fn(),
                warn: vi.fn(),
            },
            runGuardedTask: task => void Promise.resolve(task()),
            nextTick,
            isPageRendered: () => true,
            invalidatePages: vi.fn(),
            renderVisiblePages: vi.fn(async () => undefined),
            hideManagedAnnotationEditors: vi.fn(),
            currentPage: ref(1),
        });
        const settleViewerLoad = vi.fn();

        await nextTick();
        managedShapes.settleViewerLoadSettledWithManagedShapes(1, settleViewerLoad);
        managedShapes.syncAfterPageRendered(1);
        await nextTick();

        expect(settleViewerLoad).toHaveBeenCalledWith(1);
        expect(importEmbeddedShapesMock).not.toHaveBeenCalled();

        await managedShapes.ensureManagedShapeBaselineReady();
        expect(importEmbeddedShapesMock).toHaveBeenCalledOnce();
    });

    it('does not start any embedded-shape import until the initial visual can paint', async () => {
        vi.useFakeTimers();
        const animationFrames: FrameRequestCallback[] = [];
        const originalWindow = globalThis.window;
        const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        });
        vi.stubGlobal('window', {requestAnimationFrame});
        const importEmbeddedShapesMock = vi.mocked(importEmbeddedShapeAnnotations);
        importEmbeddedShapesMock.mockReset();
        importEmbeddedShapesMock.mockResolvedValue([]);

        try {
            const managedShapes = useManagedEmbeddedPdfShapes({
                viewerContainer: ref(createRenderedViewerContainer()),
                workingCopyPath: ref(null),
                sourcePdfData: ref<Uint8Array | null>(new Uint8Array([1])),
                documentRevisionToken: ref(null),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                bufferPages: ref(0),
                shapeComposable: createManagedShapeStorePort(),
                deletedEmbeddedAnnotationIds: ref(new Set<string>()),
                logger: {
                    debug: vi.fn(),
                    warn: vi.fn(),
                },
                runGuardedTask: task => void Promise.resolve(task()),
                nextTick,
                isPageRendered: () => true,
                invalidatePages: vi.fn(),
                renderVisiblePages: vi.fn(async () => undefined),
                hideManagedAnnotationEditors: vi.fn(),
                currentPage: ref(1),
            });
            const settleViewerLoad = vi.fn();

            managedShapes.settleViewerLoadSettledWithManagedShapes(7, settleViewerLoad);

            expect(settleViewerLoad).toHaveBeenCalledWith(7);
            expect(importEmbeddedShapesMock).not.toHaveBeenCalled();
            // A preserved canvas from the previous source is insufficient. The
            // current source must report a completed visible-page render.
            expect(animationFrames).toHaveLength(0);
            managedShapes.syncAfterPageRendered(1);
            for (let frame = 0; frame < 2; frame += 1) {
                const frameCallbacks = animationFrames.splice(0);
                frameCallbacks.forEach(callback => callback(performance.now()));
                await Promise.resolve();
                expect(importEmbeddedShapesMock).not.toHaveBeenCalled();
            }

            const paintBoundaryCallbacks = animationFrames.splice(0);
            paintBoundaryCallbacks.forEach(callback => callback(performance.now()));
            await vi.runAllTimersAsync();
            await vi.waitFor(() => expect(importEmbeddedShapesMock).toHaveBeenCalledOnce());
        } finally {
            vi.useRealTimers();
            if (originalWindow === undefined) {
                vi.unstubAllGlobals();
            } else {
                vi.stubGlobal('window', originalWindow);
            }
        }
    });

    it('ignores empty setup churn and imports a late working copy once after the document canvas', async () => {
        vi.useFakeTimers();
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('window', {requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        })});
        const importEmbeddedShapesMock = vi.mocked(importEmbeddedShapeAnnotations);
        importEmbeddedShapesMock.mockReset().mockResolvedValue([]);
        const originalPath = ref<string | null>('/documents/arnold.pdf');
        const workingCopyPath = ref<string | null>(null);
        const documentRevisionToken = ref<TDocumentRevisionToken | null>(null);

        try {
            const managedShapes = useManagedEmbeddedPdfShapes({
                viewerContainer: ref(createRenderedViewerContainer()),
                originalPath,
                workingCopyPath,
                sourcePdfData: ref<Uint8Array | null>(null),
                documentRevisionToken,
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                bufferPages: ref(0),
                shapeComposable: createManagedShapeStorePort(),
                deletedEmbeddedAnnotationIds: ref(new Set<string>()),
                logger: {
                    debug: vi.fn(),
                    warn: vi.fn(),
                },
                runGuardedTask: task => void Promise.resolve(task()),
                nextTick,
                isPageRendered: () => true,
                invalidatePages: vi.fn(),
                renderVisiblePages: vi.fn(async () => undefined),
                hideManagedAnnotationEditors: vi.fn(),
                currentPage: ref(1),
            });
            managedShapes.settleViewerLoadSettledWithManagedShapes(1, vi.fn());
            documentRevisionToken.value = requireDocumentRevisionToken('arnold-revision');
            await nextTick();
            expect(importEmbeddedShapesMock).not.toHaveBeenCalled();

            // The canvas may commit before Electron publishes the managed
            // working-copy path. Its document identity remains authoritative.
            managedShapes.syncAfterPageRendered(1);
            workingCopyPath.value = '/tmp/pdf-work/arnold.pdf';
            await nextTick();
            await nextTick();
            await Promise.resolve();
            expect(importEmbeddedShapesMock).not.toHaveBeenCalled();
            expect(animationFrames).toHaveLength(1);

            for (let frame = 0; frame < 2; frame += 1) {
                animationFrames.splice(0).forEach(callback => callback(performance.now()));
            }
            await vi.runAllTimersAsync();
            await vi.waitFor(() => expect(importEmbeddedShapesMock).toHaveBeenCalledOnce());
        } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
        }
    });

    it('retains a deferred import when its rendered canvas swaps before the paint boundary', async () => {
        vi.useFakeTimers();
        const animationFrames: FrameRequestCallback[] = [];
        let hasCurrentCanvas = true;
        const viewerContainer = Object.assign(Object.create(null), {
            querySelector: (selector: string) => (
                hasCurrentCanvas
                && (
                    selector === '.page_container--rendered .page_canvas canvas'
                    || selector === '.page_container[data-page="1"] .page_canvas canvas'
                )
                    ? {}
                    : null
            ),
            querySelectorAll: () => [],
        }) as HTMLElement;
        vi.stubGlobal('window', {requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        })});
        const importEmbeddedShapesMock = vi.mocked(importEmbeddedShapeAnnotations);
        importEmbeddedShapesMock.mockReset().mockResolvedValue([]);

        try {
            const managedShapes = useManagedEmbeddedPdfShapes({
                viewerContainer: ref(viewerContainer),
                workingCopyPath: ref(null),
                sourcePdfData: ref<Uint8Array | null>(new Uint8Array([1])),
                documentRevisionToken: ref(null),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                bufferPages: ref(0),
                shapeComposable: createManagedShapeStorePort(),
                deletedEmbeddedAnnotationIds: ref(new Set<string>()),
                logger: {
                    debug: vi.fn(),
                    warn: vi.fn(),
                },
                runGuardedTask: task => void Promise.resolve(task()),
                nextTick,
                isPageRendered: () => true,
                invalidatePages: vi.fn(),
                renderVisiblePages: vi.fn(async () => undefined),
                hideManagedAnnotationEditors: vi.fn(),
                currentPage: ref(1),
            });
            managedShapes.settleViewerLoadSettledWithManagedShapes(1, vi.fn());
            managedShapes.syncAfterPageRendered(1);

            animationFrames.splice(0).forEach(callback => callback(performance.now()));
            animationFrames.splice(0).forEach(callback => callback(performance.now()));
            hasCurrentCanvas = false;
            await vi.runAllTimersAsync();
            expect(importEmbeddedShapesMock).not.toHaveBeenCalled();

            hasCurrentCanvas = true;
            managedShapes.syncAfterPageRendered(1);
            animationFrames.splice(0).forEach(callback => callback(performance.now()));
            animationFrames.splice(0).forEach(callback => callback(performance.now()));
            await vi.runAllTimersAsync();

            await vi.waitFor(() => expect(importEmbeddedShapesMock).toHaveBeenCalledOnce());
        } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
        }
    });

    it('parses path-backed PDFs even when a raw-name preflight could not prove shape presence', async () => {
        const bytes = new Uint8Array([
            1,
            2,
            3,
        ]);
        vi.mocked(readDocumentBytes).mockReset().mockResolvedValue(bytes);
        vi.mocked(importEmbeddedShapeAnnotations).mockReset().mockResolvedValue([]);
        const shapeComposable = createManagedShapeStorePort();
        const managedShapes = useManagedEmbeddedPdfShapes({
            viewerContainer: ref(createRenderedViewerContainer()),
            workingCopyPath: ref('/tmp/large-shapes.pdf'),
            sourcePdfData: ref(null),
            documentRevisionToken: ref(null),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            bufferPages: ref(0),
            shapeComposable,
            deletedEmbeddedAnnotationIds: ref(new Set<string>()),
            logger: {
                debug: vi.fn(),
                warn: vi.fn(),
            },
            runGuardedTask: task => void Promise.resolve(task()),
            nextTick,
            isPageRendered: () => true,
            invalidatePages: vi.fn(),
            renderVisiblePages: vi.fn(async () => undefined),
            hideManagedAnnotationEditors: vi.fn(),
            currentPage: ref(1),
        });

        await managedShapes.ensureManagedShapeBaselineReady();

        expect(shapeComposable.importEmbeddedShapes).toHaveBeenCalledWith(
            [],
            expect.objectContaining({path: '/tmp/large-shapes.pdf'}),
        );
        expect(readDocumentBytes).toHaveBeenCalledWith('/tmp/large-shapes.pdf', {signal: expect.any(AbortSignal)});
        expect(importEmbeddedShapeAnnotations).toHaveBeenCalledWith(bytes);
    });

    it('imports actual embedded shapes from path-backed bytes', async () => {
        const bytes = new Uint8Array([
            1,
            2,
            3,
        ]);
        vi.mocked(readDocumentBytes).mockReset().mockResolvedValue(bytes);
        vi.mocked(importEmbeddedShapeAnnotations).mockReset().mockResolvedValue([createEmbeddedInkShape({annotationId: '91R'})]);
        const shapeComposable = createManagedShapeStorePort();
        const managedShapes = useManagedEmbeddedPdfShapes({
            viewerContainer: ref(createRenderedViewerContainer()),
            workingCopyPath: ref('/tmp/large-shapes.pdf'),
            sourcePdfData: ref(null),
            documentRevisionToken: ref(null),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            bufferPages: ref(0),
            shapeComposable,
            deletedEmbeddedAnnotationIds: ref(new Set<string>()),
            logger: {
                debug: vi.fn(),
                warn: vi.fn(),
            },
            runGuardedTask: task => void Promise.resolve(task()),
            nextTick,
            isPageRendered: () => true,
            invalidatePages: vi.fn(),
            renderVisiblePages: vi.fn(async () => undefined),
            hideManagedAnnotationEditors: vi.fn(),
            currentPage: ref(1),
        });

        await managedShapes.ensureManagedShapeBaselineReady();

        expect(shapeComposable.importEmbeddedShapes).toHaveBeenCalledWith(
            [expect.objectContaining({annotationId: '91R'})],
            expect.objectContaining({path: '/tmp/large-shapes.pdf'}),
        );
        expect(readDocumentBytes).toHaveBeenCalledWith('/tmp/large-shapes.pdf', {signal: expect.any(AbortSignal)});
    });

    it('retries a transient failed import for the unchanged source', async () => {
        const bytes = new Uint8Array([
            1,
            2,
            3,
        ]);
        vi.mocked(importEmbeddedShapeAnnotations)
            .mockReset()
            .mockRejectedValueOnce(new Error('transient worker failure'))
            .mockResolvedValueOnce([createEmbeddedInkShape({annotationId: '92R'})]);
        const shapeComposable = createManagedShapeStorePort();
        const managedShapes = useManagedEmbeddedPdfShapes({
            viewerContainer: ref(createRenderedViewerContainer()),
            workingCopyPath: ref('/tmp/retry-shapes.pdf'),
            sourcePdfData: ref(bytes),
            documentRevisionToken: ref(null),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            bufferPages: ref(0),
            shapeComposable,
            deletedEmbeddedAnnotationIds: ref(new Set<string>()),
            logger: {
                debug: vi.fn(),
                warn: vi.fn(),
            },
            runGuardedTask: task => void Promise.resolve(task()),
            nextTick,
            isPageRendered: () => true,
            invalidatePages: vi.fn(),
            renderVisiblePages: vi.fn(async () => undefined),
            hideManagedAnnotationEditors: vi.fn(),
            currentPage: ref(1),
        });

        await expect(managedShapes.ensureManagedShapeBaselineReady())
            .rejects.toThrow('Failed to establish embedded PDF shape baseline');
        await expect(managedShapes.ensureManagedShapeBaselineReady()).resolves.toBe(true);

        expect(importEmbeddedShapeAnnotations).toHaveBeenCalledTimes(2);
        expect(shapeComposable.importEmbeddedShapes).toHaveBeenCalledWith(
            [expect.objectContaining({annotationId: '92R'})],
            expect.objectContaining({path: '/tmp/retry-shapes.pdf'}),
        );
    });

    it('keeps the session usable when the shape layer is too large to scan', async () => {
        vi.mocked(importEmbeddedShapeAnnotations)
            .mockReset()
            .mockRejectedValue(new RangeError('Embedded shape import is unavailable for PDFs larger than 96 MiB'));
        const shapeComposable = createManagedShapeStorePort();
        const managedShapes = useManagedEmbeddedPdfShapes({
            viewerContainer: ref(createRenderedViewerContainer()),
            workingCopyPath: ref('/tmp/oversized-shapes.pdf'),
            sourcePdfData: ref(new Uint8Array([
                1,
                2,
                3,
            ])),
            documentRevisionToken: ref(null),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            bufferPages: ref(0),
            shapeComposable,
            deletedEmbeddedAnnotationIds: ref(new Set<string>()),
            logger: {
                debug: vi.fn(),
                warn: vi.fn(),
            },
            runGuardedTask: task => void Promise.resolve(task()),
            nextTick,
            isPageRendered: () => true,
            invalidatePages: vi.fn(),
            renderVisiblePages: vi.fn(async () => undefined),
            hideManagedAnnotationEditors: vi.fn(),
            currentPage: ref(1),
        });

        // A resource refusal is not a defective document: the save path must be
        // told the layer is unknown rather than blocked outright.
        await expect(managedShapes.ensureManagedShapeBaselineReady()).resolves.toBe(false);
        expect(shapeComposable.importEmbeddedShapes).not.toHaveBeenCalled();
        expect(shapeComposable.clearPendingShapeImportAdoption).toHaveBeenCalled();
    });

    it('parses saved bytes before priming a shape-free baseline', async () => {
        vi.mocked(importEmbeddedShapeAnnotations).mockReset().mockResolvedValue([]);
        const primePersistedShapes = vi.fn(() => true);
        const beginShapeSave = () => ({
            primePersistedShapes,
            rollback: vi.fn(() => true),
        });
        const shapeComposable = createManagedShapeStorePort({beginShapeSave});
        const managedShapes = useManagedEmbeddedPdfShapes({
            viewerContainer: ref(createRenderedViewerContainer()),
            workingCopyPath: ref('/tmp/shape-free.pdf'),
            sourcePdfData: ref(new Uint8Array([1])),
            documentRevisionToken: ref(null),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            bufferPages: ref(0),
            shapeComposable,
            deletedEmbeddedAnnotationIds: ref(new Set<string>()),
            logger: {
                debug: vi.fn(),
                warn: vi.fn(),
            },
            runGuardedTask: task => void Promise.resolve(task()),
            nextTick,
            isPageRendered: () => true,
            invalidatePages: vi.fn(),
            renderVisiblePages: vi.fn(async () => undefined),
            hideManagedAnnotationEditors: vi.fn(),
            currentPage: ref(1),
        });

        await expect(managedShapes.preparePersistedManagedShapesForSave(
            new TextEncoder().encode('%PDF-1.7\n% shape-free 431-page representative'),
        )).resolves.toMatchObject({rollback: expect.any(Function)});

        expect(primePersistedShapes).toHaveBeenCalledWith([]);
        expect(importEmbeddedShapeAnnotations).toHaveBeenCalledOnce();
    });

    it('adopts same-source saved shape metadata without rerendering the visible canvas', async () => {
        const {
            application,
            shapeComposable,
        } = createCanonicalShapeProjection();
        const importEmbeddedShapesMock = vi.mocked(importEmbeddedShapeAnnotations);
        importEmbeddedShapesMock.mockReset();
        importEmbeddedShapesMock
            .mockResolvedValueOnce([])
            .mockImplementationOnce(async () => {
                const shape = shapeComposable.getAllShapes()[0];
                if (!shape) {
                    return [];
                }
                return [createEmbeddedInkShape({
                    annotationId: '42R',
                    stableKey: shape.stableKey,
                    x: shape.x + 0.02,
                    y: shape.y + 0.03,
                    width: shape.width + 0.04,
                    height: shape.height + 0.05,
                    points: shape.points?.map(point => ({
                        x: point.x + 0.02,
                        y: point.y + 0.03,
                    })),
                    strokes: shape.strokes?.map(stroke => stroke.map(point => ({
                        x: point.x + 0.02,
                        y: point.y + 0.03,
                    }))),
                })];
            });

        const viewerContainer = ref<HTMLElement | null>(createRenderedViewerContainer());
        const initialSourcePdfData = new Uint8Array([1]);
        const sourcePdfData = ref<Uint8Array | null>(initialSourcePdfData);
        const invalidatePages = vi.fn();
        const renderVisiblePages = vi.fn(async () => {});
        const managedShapes = useManagedEmbeddedPdfShapes({
            viewerContainer,
            workingCopyPath: ref('/tmp/work.pdf'),
            sourcePdfData,
            documentRevisionToken: ref(null),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            bufferPages: ref(0),
            shapeComposable,
            deletedEmbeddedAnnotationIds: ref(new Set<string>()),
            logger: {
                debug: vi.fn(),
                warn: vi.fn(),
            },
            runGuardedTask: task => void Promise.resolve(task()),
            nextTick,
            isPageRendered: pageNumber => pageNumber === 1,
            invalidatePages,
            renderVisiblePages,
            hideManagedAnnotationEditors: vi.fn(),
            currentPage: ref(1),
        });
        managedShapes.settleViewerLoadSettledWithManagedShapes(1, vi.fn());
        managedShapes.syncAfterPageRendered(1);

        await vi.waitFor(() => {
            expect(importEmbeddedShapesMock).toHaveBeenCalledTimes(1);
        });

        shapeComposable.startDrawing(0, 'draw', 0.1, 0.2, DEFAULT_ANNOTATION_SETTINGS);
        shapeComposable.continueDrawing(0.15, 0.25);
        shapeComposable.continueDrawing(0.25, 0.35);
        const created = shapeComposable.finishDrawing();
        expect(created).not.toBeNull();

        const originalPoints = created!.points?.map(point => ({ ...point }));
        const originalStrokes = created!.strokes?.map(stroke => stroke.map(point => ({ ...point })));
        application.value.createShapeFromGeometry(created!);
        application.value.store.adoptPersistedShapesOnNextImport();
        invalidatePages.mockClear();
        renderVisiblePages.mockClear();

        sourcePdfData.value = new Uint8Array([2]);
        await nextTick();
        managedShapes.settleViewerLoadSettledWithManagedShapes(2, vi.fn());
        managedShapes.syncAfterPageRendered(1);

        await vi.waitFor(() => {
            expect(importEmbeddedShapesMock).toHaveBeenCalledTimes(2);
            expect(shapeComposable.getShapeById(created!.id)).toMatchObject({
                id: created!.id,
                source: 'embedded',
                annotationId: '42R',
                stableKey: created!.stableKey,
                x: created!.x,
                y: created!.y,
                width: created!.width,
                height: created!.height,
            });
        });

        expect(shapeComposable.getShapeById(created!.id)?.points).toEqual(originalPoints);
        expect(shapeComposable.getShapeById(created!.id)?.strokes).toEqual(originalStrokes);
        expect(shapeComposable.hasShapes.value).toBe(false);
        expect(invalidatePages).not.toHaveBeenCalled();
        expect(renderVisiblePages).not.toHaveBeenCalled();
    });

    it('rerenders hidden annotation pages without invalidating the mounted canvas first', async () => {
        vi.mocked(importEmbeddedShapeAnnotations).mockReset();
        const pendingTasks: Array<Promise<unknown>> = [];
        const invalidatePages = vi.fn();
        const renderVisiblePages = vi.fn(async () => {});
        const managedShapes = useManagedEmbeddedPdfShapes({
            viewerContainer: ref(null),
            workingCopyPath: ref(null),
            sourcePdfData: ref(null),
            documentRevisionToken: ref(null),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            bufferPages: ref(0),
            shapeComposable: createManagedShapeStorePort(),
            deletedEmbeddedAnnotationIds: ref(new Set<string>()),
            logger: {
                debug: vi.fn(),
                warn: vi.fn(),
            },
            runGuardedTask: (task) => {
                pendingTasks.push(Promise.resolve(task()));
            },
            nextTick,
            isPageRendered: pageNumber => pageNumber === 1,
            invalidatePages,
            renderVisiblePages,
            hideManagedAnnotationEditors: vi.fn(),
            currentPage: ref(1),
        });

        managedShapes.refreshHiddenAnnotationPage({ pageNumber: 1 });
        await Promise.all(pendingTasks);

        expect(invalidatePages).not.toHaveBeenCalled();
        expect(renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 1,
                end: 1,
            },
            {
                preserveRenderedPages: true,
                forceRerender: true,
                bufferOverride: 0,
            },
        );
    });

    it('repaints the page when a deleted annotation stops being hidden', async () => {
        vi.mocked(importEmbeddedShapeAnnotations).mockReset();
        const pendingTasks: Array<Promise<unknown>> = [];
        const renderVisiblePages = vi.fn(async () => {});
        const deletedEmbeddedAnnotationIds = ref(new Set(['12R']));
        useManagedEmbeddedPdfShapes({
            viewerContainer: ref(null),
            workingCopyPath: ref(null),
            sourcePdfData: ref(null),
            documentRevisionToken: ref(null),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            bufferPages: ref(0),
            shapeComposable: createManagedShapeStorePort(),
            deletedEmbeddedAnnotationIds,
            logger: {
                debug: vi.fn(),
                warn: vi.fn(),
            },
            runGuardedTask: (task) => {
                pendingTasks.push(Promise.resolve(task()));
            },
            nextTick,
            isPageRendered: pageNumber => pageNumber === 1,
            invalidatePages: vi.fn(),
            renderVisiblePages,
            hideManagedAnnotationEditors: vi.fn(),
            currentPage: ref(1),
        });
        await nextTick();
        await Promise.all(pendingTasks);
        renderVisiblePages.mockClear();

        // Undo drops the tombstone. Suppression had removed the element from the
        // annotation layer outright, so only a repaint can bring it back.
        deletedEmbeddedAnnotationIds.value = new Set<string>();
        await nextTick();
        await Promise.all(pendingTasks);
        await nextTick();
        await Promise.all(pendingTasks);

        expect(renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 1,
                end: 1,
            },
            {
                preserveRenderedPages: true,
                forceRerender: true,
                bufferOverride: 0,
            },
        );
    });

    it('suppresses managed annotations from canvas before their page overlay is ready', async () => {
        const { shapeComposable } = createCanonicalShapeProjection();
        const importEmbeddedShapesMock = vi.mocked(importEmbeddedShapeAnnotations);
        importEmbeddedShapesMock.mockReset();
        importEmbeddedShapesMock.mockResolvedValueOnce([createEmbeddedInkShape({ annotationId: '12R0' })]);
        const viewerContainer = ref<HTMLElement | null>(
            createRenderedViewerContainer({ hasShapeOverlay: false }),
        );
        const pendingTasks: Array<Promise<unknown>> = [];
        const renderVisiblePages = vi.fn(async () => {});
        const managedShapes = useManagedEmbeddedPdfShapes({
            viewerContainer,
            workingCopyPath: ref('/tmp/work.pdf'),
            sourcePdfData: ref<Uint8Array | null>(new Uint8Array([1])),
            documentRevisionToken: ref(null),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            bufferPages: ref(0),
            shapeComposable,
            deletedEmbeddedAnnotationIds: ref(new Set<string>()),
            logger: {
                debug: vi.fn(),
                warn: vi.fn(),
            },
            runGuardedTask: (task) => {
                pendingTasks.push(Promise.resolve(task()));
            },
            nextTick,
            isPageRendered: pageNumber => pageNumber === 1,
            invalidatePages: vi.fn(),
            renderVisiblePages,
            hideManagedAnnotationEditors: vi.fn(),
            currentPage: ref(1),
        });
        managedShapes.settleViewerLoadSettledWithManagedShapes(1, vi.fn());
        managedShapes.syncAfterPageRendered(1);

        await vi.waitFor(() => {
            expect(importEmbeddedShapesMock).toHaveBeenCalledOnce();
            expect(managedShapes.hiddenEmbeddedAnnotationIds.value.has('12R')).toBe(true);
        });
        await vi.waitFor(() => {
            expect(renderVisiblePages).toHaveBeenCalled();
        });
        renderVisiblePages.mockClear();

        expect(managedShapes.renderHiddenEmbeddedAnnotationIds.value.has('12R')).toBe(true);

        viewerContainer.value = createRenderedViewerContainer({
            hasShapeOverlay: true,
            shapeOverlayAnnotationIds: ['34R'],
        });
        managedShapes.syncAfterPageRendered(1);

        expect(managedShapes.renderHiddenEmbeddedAnnotationIds.value.has('12R')).toBe(true);

        viewerContainer.value = createRenderedViewerContainer({ hasShapeOverlay: true });
        managedShapes.syncAfterPageRendered(1);

        expect(managedShapes.renderHiddenEmbeddedAnnotationIds.value.has('12R')).toBe(true);
        await Promise.all(pendingTasks);
        expect(renderVisiblePages).not.toHaveBeenCalled();
    });

    it('reconciles a deferred baseline when live tombstones appear during import', async () => {
        const imported = Promise.withResolvers<IShapeAnnotation[]>();
        vi.mocked(importEmbeddedShapeAnnotations).mockReset().mockReturnValueOnce(imported.promise);
        let deletedAnnotationIds: string[] = [];
        const shapeComposable = createManagedShapeStorePort({getDeletedEmbeddedAnnotationIds: () => deletedAnnotationIds});
        const managedShapes = useManagedEmbeddedPdfShapes({
            viewerContainer: ref(createRenderedViewerContainer()),
            workingCopyPath: ref('/tmp/work.pdf'),
            sourcePdfData: ref<Uint8Array | null>(new Uint8Array([1])),
            documentRevisionToken: ref(null),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            bufferPages: ref(0),
            shapeComposable,
            deletedEmbeddedAnnotationIds: ref(new Set<string>()),
            logger: {
                debug: vi.fn(),
                warn: vi.fn(),
            },
            runGuardedTask: task => void Promise.resolve(task()),
            nextTick,
            isPageRendered: () => true,
            invalidatePages: vi.fn(),
            renderVisiblePages: vi.fn(async () => undefined),
            hideManagedAnnotationEditors: vi.fn(),
            currentPage: ref(1),
        });

        managedShapes.settleViewerLoadSettledWithManagedShapes(1, vi.fn());
        managedShapes.syncAfterPageRendered(1);
        await vi.waitFor(() => expect(importEmbeddedShapeAnnotations).toHaveBeenCalledOnce());
        deletedAnnotationIds = ['77R'];
        imported.resolve([createEmbeddedInkShape({annotationId: '77R'})]);
        await managedShapes.ensureManagedShapeBaselineReady();

        // The composable forwards the scan; the store alone picks the mode.
        expect(shapeComposable.importEmbeddedShapes).toHaveBeenCalledOnce();
        expect(shapeComposable.importEmbeddedShapes).toHaveBeenCalledWith(
            [expect.objectContaining({annotationId: '77R'})],
            expect.objectContaining({path: '/tmp/work.pdf'}),
        );
    });

    it('does not apply an embedded-shape import after its scope is disposed', async () => {
        const imported = Promise.withResolvers<IShapeAnnotation[]>();
        const importEmbeddedShapesMock = vi.mocked(importEmbeddedShapeAnnotations);
        importEmbeddedShapesMock.mockReset();
        importEmbeddedShapesMock.mockReturnValueOnce(imported.promise);
        const shapeComposable = createManagedShapeStorePort();
        const scope = effectScope();
        const managedShapes = scope.run(() => useManagedEmbeddedPdfShapes({
            viewerContainer: ref<HTMLElement | null>(createRenderedViewerContainer()),
            workingCopyPath: ref('/tmp/work.pdf'),
            sourcePdfData: ref<Uint8Array | null>(new Uint8Array([1])),
            documentRevisionToken: ref(null),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            bufferPages: ref(0),
            shapeComposable,
            deletedEmbeddedAnnotationIds: ref(new Set<string>()),
            logger: {
                debug: vi.fn(),
                warn: vi.fn(),
            },
            runGuardedTask: task => void Promise.resolve(task()),
            nextTick,
            isPageRendered: () => true,
            invalidatePages: vi.fn(),
            renderVisiblePages: vi.fn(async () => undefined),
            hideManagedAnnotationEditors: vi.fn(),
            currentPage: ref(1),
        }));
        managedShapes?.settleViewerLoadSettledWithManagedShapes(1, vi.fn());
        managedShapes?.syncAfterPageRendered(1);
        await vi.waitFor(() => expect(importEmbeddedShapesMock).toHaveBeenCalledOnce());
        vi.mocked(shapeComposable.importEmbeddedShapes).mockClear();

        scope.stop();
        imported.resolve([createEmbeddedInkShape({annotationId: '77R'})]);
        await Promise.resolve();
        await Promise.resolve();

        expect(shapeComposable.importEmbeddedShapes).not.toHaveBeenCalled();
    });

    it('deduplicates revision-equivalent imports without coupling runtime disposal', async () => {
        const imported = Promise.withResolvers<IShapeAnnotation[]>();
        const importEmbeddedShapesMock = vi.mocked(importEmbeddedShapeAnnotations);
        importEmbeddedShapesMock.mockReset().mockReturnValueOnce(imported.promise);
        const firstShapeComposable = createManagedShapeStorePort();
        const secondShapeComposable = createManagedShapeStorePort();
        const revision = requireDocumentRevisionToken('revision-shared-runtime');
        const firstScope = effectScope();
        const secondScope = effectScope();
        const createRuntime = (
            scope: ReturnType<typeof effectScope>,
            shapeComposable: IManagedEmbeddedPdfShapeProjectionPort,
            data: Uint8Array,
            workingCopyPath: string,
        ) => scope.run(() => useManagedEmbeddedPdfShapes({
            viewerContainer: ref<HTMLElement | null>(createRenderedViewerContainer()),
            originalPath: ref('/documents/stable-source.pdf'),
            workingCopyPath: ref(workingCopyPath),
            sourcePdfData: ref<Uint8Array | null>(data),
            documentRevisionToken: ref(revision),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            bufferPages: ref(0),
            shapeComposable,
            deletedEmbeddedAnnotationIds: ref(new Set<string>()),
            logger: {
                debug: vi.fn(),
                warn: vi.fn(),
            },
            runGuardedTask: task => void Promise.resolve(task()),
            nextTick,
            isPageRendered: () => true,
            invalidatePages: vi.fn(),
            renderVisiblePages: vi.fn(async () => undefined),
            hideManagedAnnotationEditors: vi.fn(),
            currentPage: ref(1),
        }));
        const firstRuntime = createRuntime(firstScope, firstShapeComposable, new Uint8Array([1]), '/tmp/work-a.pdf');
        const secondRuntime = createRuntime(secondScope, secondShapeComposable, new Uint8Array([2]), '/tmp/work-b.pdf');

        const firstBaseline = firstRuntime!.ensureManagedShapeBaselineReady();
        const secondBaseline = secondRuntime!.ensureManagedShapeBaselineReady();
        await vi.waitFor(() => expect(importEmbeddedShapesMock).toHaveBeenCalledOnce());
        firstScope.stop();
        imported.resolve([createEmbeddedInkShape({annotationId: 'shared-1'})]);

        await expect(firstBaseline).resolves.toBe(true);
        await expect(secondBaseline).resolves.toBe(true);
        expect(firstShapeComposable.importEmbeddedShapes).not.toHaveBeenCalled();
        expect(secondShapeComposable.importEmbeddedShapes).toHaveBeenCalledWith(
            [expect.objectContaining({annotationId: 'shared-1'})],
            expect.objectContaining({path: '/tmp/work-b.pdf'}),
        );
        secondScope.stop();
    });
});
