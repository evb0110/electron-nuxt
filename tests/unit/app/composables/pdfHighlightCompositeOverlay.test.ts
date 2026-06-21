// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { composeHighlightFragments } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/composeHighlightFragments';
import { disconnectHighlightCompositeOverlay } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/disconnectHighlightCompositeOverlay';
import { extractRectsFromHighlightPath } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/extractRectsFromHighlightPath';
import { isRectangularHighlightPathData } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/isRectangularHighlightPathData';
import { observeHighlightCompositeOverlay } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/observeHighlightCompositeOverlay';
import { shouldCompositeHighlightClassList } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/shouldCompositeHighlightClassList';
import { shouldCompositeHighlightSources } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/shouldCompositeHighlightSources';

const refreshHighlightCompositeOverlayMock = vi.hoisted(() => vi.fn());

vi.mock('@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/refreshHighlightCompositeOverlay', () => ({ refreshHighlightCompositeOverlay: refreshHighlightCompositeOverlayMock }));

function createSource(x: number, fill = '#ffff66') {
    return {
        x,
        y: 0,
        width: 50,
        height: 10,
        fill,
        opacity: '1',
    };
}

function createPageContainer() {
    const pageContainer = document.createElement('div');
    pageContainer.className = 'page_container';
    const host = document.createElement('div');
    host.className = 'page_canvas';
    pageContainer.append(host);
    document.body.append(pageContainer);
    return {
        host,
        pageContainer,
    };
}

function createHighlightSvg(className = 'highlight') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', className);
    return svg;
}

function createMutationObserverHarness() {
    const harness = {
        callback: null as MutationCallback | null,
        disconnect: vi.fn(),
        observe: vi.fn(),
        options: null as MutationObserverInit | null,
    };

    class TestMutationObserver {
        constructor(callback: MutationCallback) {
            harness.callback = callback;
        }

        observe(target: Node, options?: MutationObserverInit) {
            harness.observe(target, options);
            harness.options = options ?? null;
        }

        disconnect() {
            harness.disconnect();
        }

        takeRecords() {
            return [];
        }
    }

    Object.defineProperty(globalThis, 'MutationObserver', {
        configurable: true,
        value: TestMutationObserver,
        writable: true,
    });
    return harness;
}

function createNodeList(...nodes: Node[]) {
    const fragment = document.createDocumentFragment();
    fragment.append(...nodes);
    return fragment.childNodes;
}

function createMutationRecord(record: Partial<MutationRecord>): MutationRecord {
    return {
        addedNodes: createNodeList(),
        attributeName: null,
        attributeNamespace: null,
        nextSibling: null,
        oldValue: null,
        previousSibling: null,
        removedNodes: createNodeList(),
        target: document.createElement('div'),
        type: 'childList',
        ...record,
    };
}

describe('pdfHighlightCompositeOverlay', () => {
    const originalMutationObserver = globalThis.MutationObserver;
    let requestAnimationFrameSpy: ReturnType<typeof vi.spyOn> | null = null;
    let cancelAnimationFrameSpy: ReturnType<typeof vi.spyOn> | null = null;

    beforeEach(() => {
        refreshHighlightCompositeOverlayMock.mockClear();
    });

    afterEach(() => {
        requestAnimationFrameSpy?.mockRestore();
        cancelAnimationFrameSpy?.mockRestore();
        requestAnimationFrameSpy = null;
        cancelAnimationFrameSpy = null;
        document.body.innerHTML = '';

        if (originalMutationObserver) {
            Object.defineProperty(globalThis, 'MutationObserver', {
                configurable: true,
                value: originalMutationObserver,
                writable: true,
            });
        } else {
            delete (globalThis as {MutationObserver?: unknown}).MutationObserver;
        }
    });

    it('uses latest highlight color in intersections instead of overlapping colors', () => {
        const fragments = composeHighlightFragments([
            {
                x: 0,
                y: 0,
                width: 50,
                height: 10,
                fill: '#ffff66',
                opacity: '1',
            },
            {
                x: 25,
                y: 0,
                width: 50,
                height: 10,
                fill: '#a6e8ff',
                opacity: '1',
            },
        ]);

        expect(fragments.map(fragment => fragment.fill)).toEqual([
            '#ffff66',
            '#a6e8ff',
        ]);
        expect(fragments.map(fragment => [
            fragment.x,
            fragment.width,
        ])).toEqual([
            [
                0,
                25,
            ],
            [
                25,
                50,
            ],
        ]);
    });

    it('composites true text highlights but leaves markup subtypes to subtype rendering', () => {
        expect(shouldCompositeHighlightClassList(['highlight'])).toBe(true);
        expect(shouldCompositeHighlightClassList([
            'highlight',
            'free',
        ])).toBe(false);
        expect(shouldCompositeHighlightClassList([
            'highlight',
            'pdf-markup-subtype-draw-underline',
        ])).toBe(false);
        expect(shouldCompositeHighlightClassList([
            'highlight',
            'pdf-markup-subtype-draw-strikeout',
        ])).toBe(false);
        expect(shouldCompositeHighlightClassList([
            'highlight',
            'pdf-layer-preserve-snapshot',
        ])).toBe(false);
    });

    it('only needs the overlay when text highlight sources overlap', () => {
        expect(shouldCompositeHighlightSources([createSource(0)])).toBe(false);
        expect(shouldCompositeHighlightSources([
            createSource(0),
            createSource(60, '#a6e8ff'),
        ])).toBe(false);
        expect(shouldCompositeHighlightSources([
            createSource(0),
            createSource(25, '#a6e8ff'),
        ])).toBe(true);
    });

    it('accepts paths that decompose into axis-aligned rectangles', () => {
        expect(isRectangularHighlightPathData('M0 0 V1 H1 V0 Z')).toBe(true);
        expect(isRectangularHighlightPathData('M0 0 V1 H1 V0 Z M2 0 V1 H3 V0 Z')).toBe(true);
        expect(isRectangularHighlightPathData('M0 0 V0.5 H1 V0.75 H0.2 V1 H0 Z')).toBe(false);
        expect(isRectangularHighlightPathData('M0 0 C 1 1 2 2 3 3 Z')).toBe(false);
    });

    it('extracts each axis-aligned subpath as its own rect', () => {
        expect(extractRectsFromHighlightPath('M0 0 V1 H1 V0 Z')).toEqual([{
            x: 0,
            y: 0,
            width: 1,
            height: 1,
        }]);
        expect(extractRectsFromHighlightPath(
            'M0.35155187337702487 0.5164319248826291 V0 H1 V0.5164319248826291 Z'
            + ' M0 1 V0.48356807511737093 H0.2803264498577965 V1 Z',
        )).toEqual([
            {
                x: 0.35155187337702487,
                y: 0,
                width: 1 - 0.35155187337702487,
                height: 0.5164319248826291,
            },
            {
                x: 0,
                y: 0.48356807511737093,
                width: 0.2803264498577965,
                height: 1 - 0.48356807511737093,
            },
        ]);
        expect(extractRectsFromHighlightPath('M0 0 V0.5 H1 V0.75 H0.2 V1 H0 Z')).toBeNull();
    });

    it('cancels a scheduled observer refresh when the composite overlay disconnects', () => {
        const harness = createMutationObserverHarness();
        const {
            host,
            pageContainer,
        } = createPageContainer();
        const highlight = createHighlightSvg();
        const frameCallbacks: FrameRequestCallback[] = [];
        requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            frameCallbacks.push(callback);
            return 24;
        });
        cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

        observeHighlightCompositeOverlay(pageContainer);
        harness.callback?.([createMutationRecord({
            addedNodes: createNodeList(highlight),
            target: host,
        })], {} as MutationObserver);

        expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);

        disconnectHighlightCompositeOverlay(pageContainer);
        frameCallbacks[0]?.(performance.now());

        expect(cancelAnimationFrameSpy).toHaveBeenCalledWith(24);
        expect(refreshHighlightCompositeOverlayMock).not.toHaveBeenCalled();
    });

    it('ignores class mutations caused by hiding composite source highlights', () => {
        const harness = createMutationObserverHarness();
        const {pageContainer} = createPageContainer();
        const highlight = createHighlightSvg('highlight pdf-highlight-composite-source');
        requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 24);

        observeHighlightCompositeOverlay(pageContainer);
        harness.callback?.([createMutationRecord({
            attributeName: 'class',
            oldValue: 'highlight',
            target: highlight,
            type: 'attributes',
        })], {} as MutationObserver);

        expect(harness.options?.attributeOldValue).toBe(true);
        expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
    });

    it('composites overlapping multi-rect highlights so the latest color wins per fragment', () => {
        const blueSubpathA = {
            x: 400,
            y: 0,
            width: 600,
            height: 500,
            fill: '#a6e8ff',
            opacity: '1',
        };
        const blueSubpathB = {
            x: 0,
            y: 500,
            width: 400,
            height: 500,
            fill: '#a6e8ff',
            opacity: '1',
        };
        const yellowOverlap = {
            x: 450,
            y: 100,
            width: 300,
            height: 300,
            fill: '#ffff66',
            opacity: '1',
        };
        const fragments = composeHighlightFragments([
            blueSubpathA,
            blueSubpathB,
            yellowOverlap,
        ]);
        const overlapFragments = fragments.filter(fragment => fragment.fill === '#ffff66');
        const blueFragments = fragments.filter(fragment => fragment.fill === '#a6e8ff');
        expect(overlapFragments).toEqual([yellowOverlap]);
        expect(blueFragments.some(fragment => (
            fragment.x < yellowOverlap.x + yellowOverlap.width
            && fragment.x + fragment.width > yellowOverlap.x
            && fragment.y < yellowOverlap.y + yellowOverlap.height
            && fragment.y + fragment.height > yellowOverlap.y
        ))).toBe(false);
    });
});
