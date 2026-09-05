import type * as TPageRuntime from '@tests/e2e/electron/helpers/pageRuntime';
import type * as TViewerDom from '@tests/e2e/electron/helpers/viewerDom';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {waitForViewerInteractive} from '@tests/e2e/electron/helpers/viewerCore';

interface IFakeElement {
    classList: {contains: (name: string) => boolean};
    dataset: Record<string, string>;
    getBoundingClientRect: () => {
        height: number;
        width: number
    };
    querySelector: (selector: string) => IFakeElement | null;
    querySelectorAll: (selector: string) => IFakeElement[];
}

const mocks = vi.hoisted(() => ({
    waitForActiveWorkspaceHost: vi.fn(async () => undefined),
    waitForFunctionInPage: vi.fn(),
}));

vi.mock('@tests/e2e/electron/helpers/pageRuntime', async importOriginal => ({
    ...await importOriginal<typeof TPageRuntime>(),
    waitForFunctionInPage: mocks.waitForFunctionInPage,
}));
vi.mock('@tests/e2e/electron/helpers/viewerDom', async importOriginal => ({
    ...await importOriginal<typeof TViewerDom>(),
    waitForActiveWorkspaceHost: mocks.waitForActiveWorkspaceHost,
}));

function createElement(options: {
    classes?: string[];
    dataset?: Record<string, string>;
    selectors?: Record<string, IFakeElement | null>;
    lists?: Record<string, IFakeElement[]>;
} = {}): IFakeElement {
    const classes = new Set(options.classes ?? []);
    const selectors = options.selectors ?? {};
    const lists = options.lists ?? {};
    return {
        classList: {contains: name => classes.has(name)},
        dataset: options.dataset ?? {},
        getBoundingClientRect: () => ({
            height: 600,
            width: 800,
        }),
        querySelector: selector => selectors[selector] ?? null,
        querySelectorAll: selector => lists[selector] ?? [],
    };
}

function installInteractivePage(options: {
    source?: IFakeElement | null;
    viewportDataset?: Record<string, string>;
    chassisDataset?: Record<string, string>;
}) {
    const source = options.source === undefined
        ? createElement()
        : options.source;
    const viewport = createElement({
        dataset: options.viewportDataset ?? {openSurfacePhase: 'ready'},
        selectors: {
            '[data-pdf-page-track]': null,
            '[data-testid="document-page-source-viewer"]': source,
        },
    });
    const chassis = createElement({
        dataset: options.chassisDataset ?? {openSurfacePresentation: 'committed'},
        selectors: {'[data-document-viewer-chassis-viewport]': viewport},
    });
    const host = createElement({selectors: {'.document-viewer-chassis': chassis}});
    const fakeDocument = {
        querySelector: (selector: string) => selector === '.editor-pane.is-active .workspace-host' ? host : null,
        querySelectorAll: (selector: string) => selector === '.workspace-host' ? [host] : [],
    };
    vi.stubGlobal('document', fakeDocument);
    vi.stubGlobal('window', {getComputedStyle: () => ({
        display: 'block',
        opacity: '1',
        visibility: 'visible',
    })});
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('viewer interactive readiness', () => {
    it('accepts a committed native DjVu source viewer', async () => {
        installInteractivePage({});
        mocks.waitForFunctionInPage.mockImplementation(async (
            _page: unknown,
            predicate: () => boolean,
        ) => {
            if (!predicate()) {
                throw new Error('interactive predicate rejected the native source viewer');
            }
        });

        await expect(waitForViewerInteractive(Object.create(null), 500)).resolves.toBeUndefined();
        expect(mocks.waitForFunctionInPage).toHaveBeenCalledOnce();
    });

    it.each([
        [
            'missing native source viewer',
            {source: null},
        ],
        [
            'uncommitted chassis presentation',
            {chassisDataset: {openSurfacePresentation: 'opening'}},
        ],
    ])('rejects %s', async (_description, options) => {
        installInteractivePage(options);
        mocks.waitForFunctionInPage.mockImplementation(async (
            _page: unknown,
            predicate: () => boolean,
        ) => {
            if (!predicate()) {
                throw new Error('interactive predicate rejected the page');
            }
        });

        await expect(waitForViewerInteractive(Object.create(null), 500))
            .rejects.toThrow('interactive predicate rejected the page');
    });
});
