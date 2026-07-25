import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import type { IPdfDocumentTransition } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    warnThrottled: vi.fn(),
    debug: vi.fn(),
}}));

class MockPdfDataRangeTransport {
    public onDataRange = vi.fn();
    public abort = vi.fn();

    constructor(length: number, initialData: Uint8Array) {
        void length;
        void initialData;
    }
}

const pdfjsState = {
    version: '5.7.284',
    GlobalWorkerOptions: { workerSrc: '' },
    VerbosityLevel: { ERRORS: 0 },
    getDocument: vi.fn(),
    PDFDataRangeTransport: MockPdfDataRangeTransport,
};

vi.mock('pdfjs-dist', () => pdfjsState);

const electronApi = createElectronPlatformApiFixture({documentFiles: {readFileRange: vi.fn()}});
vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => electronApi}));

const {createPdfDocumentSession} = await import('@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession');

function createDocumentProxy(id: string) {
    return {
        id,
        numPages: 1,
        getPage: vi.fn(async () => ({
            getViewport: () => ({
                width: 100,
                height: 200,
            }),
            cleanup: vi.fn(),
        })),
        destroy: vi.fn(async () => undefined),
        cleanup: vi.fn(async () => undefined),
    };
}

/** Resolves the PDF.js loading task only when the test asks for it. */
function createDeferredLoadingTask(document: ReturnType<typeof createDocumentProxy>) {
    let resolveTask!: (value: unknown) => void;
    const promise = new Promise((resolve) => {
        resolveTask = resolve;
    });
    return {
        task: {
            promise,
            destroy: vi.fn(async () => undefined),
        },
        settle: () => resolveTask(document),
    };
}

describe('PdfDocumentSession transitions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('URL', {
            ...URL,
            createObjectURL: () => 'blob:pdf',
            revokeObjectURL: () => undefined,
        });
    });

    it('emits loading, ready and settled to subscribers in subscription order', async () => {
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(createDocumentProxy('a')),
            destroy: vi.fn(),
        });
        const source = computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never);
        const session = createPdfDocumentSession({src: source});
        const observed: string[] = [];
        session.subscribe(transition => {
            observed.push(`viewport:${transition.phase}`);
        });
        session.subscribe(transition => {
            observed.push(`rendering:${transition.phase}`);
        });

        await session.load();

        expect(observed).toEqual([
            'viewport:loading',
            'rendering:loading',
            'viewport:ready',
            'rendering:ready',
            'viewport:settled',
            'rendering:settled',
        ]);
    });

    it('restores a remounted rendering subscriber after its predecessor wedged mid-open', async () => {
        const wedgedDocument = createDocumentProxy('wedged');
        const wedged = createDeferredLoadingTask(wedgedDocument);
        const recoveredDocument = createDocumentProxy('recovered');
        pdfjsState.getDocument
            .mockReturnValueOnce(wedged.task)
            .mockReturnValue({
                promise: Promise.resolve(recoveredDocument),
                destroy: vi.fn(),
            });

        const source = computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never);
        const predecessor = createPdfDocumentSession({src: source});
        const predecessorPhases: IPdfDocumentTransition[] = [];
        predecessor.subscribe(transition => {
            predecessorPhases.push(transition);
        });

        // The predecessor open never resolves: it parks in `loading`.
        const wedgedLoad = predecessor.load();
        await vi.waitFor(() => {
            expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        });
        expect(predecessorPhases.map(phase => phase.phase)).toEqual(['loading']);
        const wedgedFence = predecessorPhases[0]!.fence;
        await predecessor.dispose();

        const active = ref(true);
        const successor = createPdfDocumentSession({
            src: source,
            isActive: computed(() => active.value),
        });
        const viewportPhases: string[] = [];
        const renderingPhases: string[] = [];
        let renderingFence: IPdfDocumentTransition['fence'] | null = null;
        successor.subscribe((transition) => {
            viewportPhases.push(transition.phase);
        });
        successor.subscribe((transition) => {
            renderingPhases.push(transition.phase);
            if (transition.phase === 'ready' || transition.phase === 'restore') {
                renderingFence = transition.fence;
            }
        });

        await successor.load();
        active.value = false;
        await nextTick();
        active.value = true;
        await vi.waitFor(() => {
            expect(renderingPhases.at(-1)).toBe('restore');
        });

        expect(viewportPhases).toEqual(renderingPhases);
        expect(successor.document.value).toBe(recoveredDocument);
        expect(renderingFence).not.toBeNull();
        expect(successor.isCurrent(renderingFence!)).toBe(true);

        // A disposed predecessor resolving afterwards cannot invalidate or
        // tear down the remounted rendering session.
        wedged.settle();
        await wedgedLoad;
        expect(predecessorPhases).toHaveLength(1);
        expect(predecessor.isCurrent(wedgedFence)).toBe(false);
        expect(successor.document.value).toBe(recoveredDocument);
        expect(renderingPhases.at(-1)).toBe('restore');
    });

    it('fences a stale ready transition before a later rendering subscriber can tear down', async () => {
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(createDocumentProxy('a')),
            destroy: vi.fn(),
        });
        const source = computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never);
        const session = createPdfDocumentSession({src: source});
        const renderingPhases: string[] = [];

        session.subscribe(async (transition) => {
            if (transition.phase === 'ready') {
                await session.invalidate('superseded-during-viewport-placement');
            }
        });
        session.subscribe((transition) => {
            renderingPhases.push(transition.phase);
        });

        await session.load();

        expect(renderingPhases).toEqual([
            'loading',
            'invalidated',
        ]);
        expect(renderingPhases).not.toContain('ready');
    });

    it('disposes registered sessions in reverse creation order', async () => {
        const session = createPdfDocumentSession();
        const disposed: string[] = [];
        session.registerDisposable(() => {
            disposed.push('viewport');
        });
        session.registerDisposable(() => {
            disposed.push('rendering');
        });
        session.registerDisposable(() => {
            disposed.push('annotation');
        });

        await session.dispose();
        expect(disposed).toEqual([
            'annotation',
            'rendering',
            'viewport',
        ]);

        // Disposal is idempotent: a second call must not re-run the tree.
        await session.dispose();
        expect(disposed).toHaveLength(3);
    });

    it('marks every fence captured before an invalidation stale', async () => {
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(createDocumentProxy('a')),
            destroy: vi.fn(),
        });
        const source = computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never);
        const session = createPdfDocumentSession({src: source});

        await session.load();
        const fence = session.captureFence();
        expect(session.isCurrent(fence)).toBe(true);

        await session.invalidate('test');
        expect(session.isCurrent(fence)).toBe(false);
    });

    it('carries preserved and selective reload intent through the typed transition', async () => {
        pdfjsState.getDocument.mockImplementation(() => ({
            promise: Promise.resolve(createDocumentProxy(crypto.randomUUID())),
            destroy: vi.fn(),
        }));
        const source = computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never);
        const session = createPdfDocumentSession({src: source});
        const loadingPlans: Array<IPdfDocumentTransition['plan']> = [];
        session.subscribe((transition) => {
            if (transition.phase === 'loading') {
                loadingPlans.push(transition.plan);
            }
        });

        await session.load();
        session.preserveNextReloadVisibleContent(true);
        await session.load(true);
        session.invalidatePagesOnNextReload([
            2,
            4,
        ]);
        await session.load(true);

        expect(loadingPlans).toEqual([
            expect.objectContaining({
                isReload: false,
                preserveVisibleContent: false,
                isSelectiveReload: false,
            }),
            expect.objectContaining({
                isReload: true,
                preserveVisibleContent: true,
                preservePageStructure: true,
                isSelectiveReload: false,
            }),
            expect.objectContaining({
                isReload: true,
                preserveVisibleContent: false,
                preservePageStructure: true,
                isSelectiveReload: true,
                pagesToInvalidate: [
                    2,
                    4,
                ],
            }),
        ]);
    });

    it('opens a source that arrives while inactive without parking on activation', async () => {
        const recoveredDocument = createDocumentProxy('warm');
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(recoveredDocument),
            destroy: vi.fn(),
        });
        const source = ref<Blob | null>(null);
        const active = ref(false);
        const session = createPdfDocumentSession({
            src: computed(() => source.value as never),
            isActive: computed(() => active.value),
        });
        const phases: string[] = [];
        session.subscribe((transition) => {
            phases.push(transition.phase);
        });

        source.value = new Blob(['pdf'], {type: 'application/pdf'});

        await vi.waitFor(() => {
            expect(session.document.value).toBe(recoveredDocument);
        });
        expect(active.value).toBe(false);
        expect(phases.slice(-3)).toEqual([
            'loading',
            'ready',
            'settled',
        ]);
    });
});
