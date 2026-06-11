// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    nextTick,
    ref,
    watch,
} from 'vue';

const resizeObserverCallbacks: Array<() => void> = [];

vi.mock('@vueuse/core', () => ({
    tryOnMounted: (callback: () => void) => callback(),
    useResizeObserver: (_target: unknown, callback: () => void) => {
        resizeObserverCallbacks.push(callback);
    },
    useMutationObserver: vi.fn(),
    useEventListener: vi.fn(),
    useRafFn: (callback: () => void, options?: { immediate?: boolean }) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let active = Boolean(options?.immediate);

        const run = () => {
            timer = null;
            if (!active) {
                return;
            }
            callback();
        };

        const resume = () => {
            active = true;
            if (timer) {
                return;
            }
            timer = setTimeout(run, 0);
        };

        const pause = () => {
            active = false;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        };

        if (active) {
            resume();
        }

        return {
            pause,
            resume,
            isActive: ref(active),
        };
    },
}));

const measuredElementSetters = new WeakMap<HTMLElement, (clientWidth: number, scrollWidth: number) => void>();

function createMeasuredElement(
    clientWidth: number,
    scrollWidth: number,
    rectLeft = 0,
): HTMLElement {
    const element = document.createElement('div');
    let measuredClientWidth = clientWidth;
    let measuredScrollWidth = scrollWidth;
    Object.defineProperties(element, {
        clientWidth: {
            configurable: true,
            get: () => measuredClientWidth,
        },
        scrollWidth: {
            configurable: true,
            get: () => measuredScrollWidth,
        },
        getBoundingClientRect: {
            configurable: true,
            value: () => ({
                left: rectLeft,
                right: rectLeft + measuredClientWidth,
                width: measuredClientWidth,
            }),
        },
    });
    measuredElementSetters.set(element, (nextClientWidth, nextScrollWidth) => {
        measuredClientWidth = nextClientWidth;
        measuredScrollWidth = nextScrollWidth;
    });
    document.body.append(element);
    return element;
}

function setElementMeasurements(
    element: HTMLElement,
    clientWidth: number,
    scrollWidth: number,
) {
    measuredElementSetters.get(element)?.(clientWidth, scrollWidth);
}

function createResponsiveToolbarElement(getClientWidth: () => number) {
    const element = createMeasuredElement(500, 500);
    Object.defineProperty(element, 'clientWidth', {
        configurable: true,
        get: getClientWidth,
    });
    return element;
}

function stubGlobals() {
    vi.stubGlobal('ref', ref);
    vi.stubGlobal('computed', computed);
    vi.stubGlobal('watch', watch);
    vi.stubGlobal('onMounted', (cb: () => void) => cb());
    vi.stubGlobal('onBeforeUnmount', vi.fn());
}

describe('useToolbarOverflow', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.clearAllMocks();
        document.body.replaceChildren();
        resizeObserverCallbacks.length = 0;
        stubGlobals();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('collapses tiers when content overflows container', async () => {
        const { useToolbarOverflow } = await import('@app/composables/useToolbarOverflow');
        const overflow = useToolbarOverflow();

        overflow.toolbarRef.value = createMeasuredElement(100, 260);
        await nextTick();
        await vi.runAllTimersAsync();

        expect(overflow.collapseTier.value).toBe(5);
        expect(overflow.hasOverflowItems.value).toBe(true);
        expect(overflow.isCollapsed(3)).toBe(true);
    });

    it('re-expands when resize removes overflow', async () => {
        const { useToolbarOverflow } = await import('@app/composables/useToolbarOverflow');
        const overflow = useToolbarOverflow();
        const toolbar = createMeasuredElement(120, 300);

        overflow.toolbarRef.value = toolbar;
        await nextTick();
        await vi.runAllTimersAsync();

        expect(overflow.collapseTier.value).toBe(5);

        setElementMeasurements(toolbar, 160, 120);
        resizeObserverCallbacks.forEach(cb => cb());
        await vi.runAllTimersAsync();

        expect(overflow.collapseTier.value).toBe(0);
        expect(overflow.hasOverflowItems.value).toBe(false);
    });

    it('detects overflow from out-of-bounds children', async () => {
        const { useToolbarOverflow } = await import('@app/composables/useToolbarOverflow');
        const overflow = useToolbarOverflow();
        const toolbar = createMeasuredElement(100, 100);
        const child = createMeasuredElement(30, 30, 85);

        toolbar.append(child);
        overflow.toolbarRef.value = toolbar;
        await nextTick();
        await vi.runAllTimersAsync();

        expect(overflow.collapseTier.value).toBe(5);
        expect(overflow.hasOverflowItems.value).toBe(true);
    });

    it('does not repeatedly retry a failed expand when the narrower tier changes measured width', async () => {
        const { useToolbarOverflow } = await import('@app/composables/useToolbarOverflow');
        const overflow = useToolbarOverflow();
        const tierChanges: number[] = [];

        watch(overflow.collapseTier, value => tierChanges.push(value));

        overflow.collapseTier.value = 1;
        overflow.toolbarRef.value = createResponsiveToolbarElement(
            () => overflow.collapseTier.value === 0 ? 490 : 500,
        );
        await nextTick();
        await vi.runAllTimersAsync();

        expect(overflow.collapseTier.value).toBe(1);
        expect(tierChanges).toContain(0);
        expect(tierChanges.at(-1)).toBe(1);

        const retriesAfterInitialPass = tierChanges.length;

        resizeObserverCallbacks.forEach(cb => cb());
        await vi.runAllTimersAsync();

        expect(overflow.collapseTier.value).toBe(1);
        expect(tierChanges).toHaveLength(retriesAfterInitialPass);
    });
});
