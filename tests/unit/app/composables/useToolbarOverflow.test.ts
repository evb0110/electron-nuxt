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
    tryOnScopeDispose: vi.fn(),
    useResizeObserver: (_target: unknown, callback: () => void) => {
        resizeObserverCallbacks.push(callback);
    },
    useMutationObserver: vi.fn(),
    useEventListener: vi.fn(),
    useDebounceFn: (callback: () => void, delay: number) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        return () => {
            if (timer) {
                clearTimeout(timer);
            }
            timer = setTimeout(() => {
                timer = null;
                callback();
            }, delay);
        };
    },
}));

class FakeElement {
    public children: unknown[] = [];
    public clientWidth = 0;
    public scrollWidth = 0;
    public rectLeft = 0;

    constructor(width: number, scrollWidth: number, rectLeft = 0) {
        this.clientWidth = width;
        this.scrollWidth = scrollWidth;
        this.rectLeft = rectLeft;
    }

    querySelector<T = FakeElement>(_selector: string): T | null {
        return null;
    }

    getBoundingClientRect() {
        return {
            left: this.rectLeft,
            right: this.rectLeft + this.clientWidth,
            width: this.clientWidth,
        };
    }
}

function cast<T>(value: unknown): T {
    return value as T;
}

function stubGlobals() {
    vi.stubGlobal('ref', ref);
    vi.stubGlobal('computed', computed);
    vi.stubGlobal('watch', watch);
    vi.stubGlobal('onMounted', (cb: () => void) => cb());
    vi.stubGlobal('onBeforeUnmount', vi.fn());
    vi.stubGlobal('HTMLElement', FakeElement);
    vi.stubGlobal('window', {
        requestAnimationFrame: (cb: FrameRequestCallback) => {
            const id = setTimeout(() => cb(0), 0);
            return id;
        },
        cancelAnimationFrame: (id: number) => clearTimeout(id),
        setTimeout,
        clearTimeout,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    });
}

describe('useToolbarOverflow', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.clearAllMocks();
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

        overflow.toolbarRef.value = cast<HTMLElement>(new FakeElement(100, 260));
        await nextTick();
        await vi.runAllTimersAsync();

        expect(overflow.collapseTier.value).toBe(5);
        expect(overflow.hasOverflowItems.value).toBe(true);
        expect(overflow.isCollapsed(3)).toBe(true);
    });

    it('re-expands when resize removes overflow', async () => {
        const { useToolbarOverflow } = await import('@app/composables/useToolbarOverflow');
        const overflow = useToolbarOverflow();
        const toolbar = new FakeElement(120, 300);

        overflow.toolbarRef.value = cast<HTMLElement>(toolbar);
        await nextTick();
        await vi.runAllTimersAsync();

        expect(overflow.collapseTier.value).toBe(5);

        toolbar.clientWidth = 160;
        toolbar.scrollWidth = 120;
        resizeObserverCallbacks.forEach(cb => cb());
        await vi.runAllTimersAsync();

        expect(overflow.collapseTier.value).toBe(0);
        expect(overflow.hasOverflowItems.value).toBe(false);
    });

    it('detects overflow from out-of-bounds children', async () => {
        const { useToolbarOverflow } = await import('@app/composables/useToolbarOverflow');
        const overflow = useToolbarOverflow();
        const toolbar = new FakeElement(100, 100);
        const child = new FakeElement(30, 30, 85);

        toolbar.children = [child];
        overflow.toolbarRef.value = cast<HTMLElement>(toolbar);
        await nextTick();
        await vi.runAllTimersAsync();

        expect(overflow.collapseTier.value).toBe(5);
        expect(overflow.hasOverflowItems.value).toBe(true);
    });
});
