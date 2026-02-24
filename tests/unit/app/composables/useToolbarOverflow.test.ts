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
const mutationObserverCallbacks: Array<() => void> = [];
const windowResizeCallbacks: Array<() => void> = [];

vi.mock('@vueuse/core', () => ({
    useResizeObserver: (_target: unknown, callback: () => void) => {
        resizeObserverCallbacks.push(callback);
    },
    useMutationObserver: (_target: unknown, callback: () => void) => {
        mutationObserverCallbacks.push(callback);
    },
    useEventListener: (_target: unknown, _event: string, callback: () => void) => {
        windowResizeCallbacks.push(callback);
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
        const left = this.rectLeft;
        const right = left + this.clientWidth;
        return {
            left,
            right,
            width: this.clientWidth,
        };
    }
}

function cast<T>(value: unknown): T {
    return value as T;
}

function stubComposableGlobals() {
    vi.stubGlobal('ref', ref);
    vi.stubGlobal('computed', computed);
    vi.stubGlobal('watch', watch);
    vi.stubGlobal('onMounted', (callback: () => void) => {
        callback();
    });
    vi.stubGlobal('onBeforeUnmount', (_callback: () => void) => {
        return;
    });
    vi.stubGlobal('HTMLElement', FakeElement);
}

function stubWindow() {
    const rafTimers = new Map<number, ReturnType<typeof setTimeout>>();
    let nextRafId = 1;

    vi.stubGlobal('window', {
        requestAnimationFrame: (callback: FrameRequestCallback) => {
            const rafId = nextRafId++;
            const timerId = setTimeout(() => {
                rafTimers.delete(rafId);
                callback(0);
            }, 0);
            rafTimers.set(rafId, timerId);
            return rafId;
        },
        cancelAnimationFrame: (id: number) => {
            const timerId = rafTimers.get(id);
            if (!timerId) {
                return;
            }
            clearTimeout(timerId);
            rafTimers.delete(id);
        },
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
        mutationObserverCallbacks.length = 0;
        windowResizeCallbacks.length = 0;
        stubComposableGlobals();
        stubWindow();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('collapses toolbar tiers when overflow persists', async () => {
        const { useToolbarOverflow } = await import('@app/composables/useToolbarOverflow');
        const overflow = useToolbarOverflow();

        overflow.toolbarRef.value = cast<HTMLElement>(new FakeElement(100, 260));
        await nextTick();

        await vi.runAllTimersAsync();

        expect(overflow.collapseTier.value).toBe(5);
        expect(overflow.hasOverflowItems.value).toBe(true);
        expect(overflow.isCollapsed(3)).toBe(true);
    });

    it('re-expands collapsed tiers after resize removes overflow', async () => {
        const { useToolbarOverflow } = await import('@app/composables/useToolbarOverflow');
        const overflow = useToolbarOverflow();
        const toolbar = new FakeElement(120, 300);

        overflow.toolbarRef.value = cast<HTMLElement>(toolbar);
        await nextTick();
        await vi.runAllTimersAsync();

        expect(overflow.collapseTier.value).toBe(5);

        toolbar.clientWidth = 160;
        toolbar.scrollWidth = 120;
        resizeObserverCallbacks.forEach(callback => callback());

        await vi.runAllTimersAsync();

        expect(overflow.collapseTier.value).toBe(0);
        expect(overflow.hasOverflowItems.value).toBe(false);
        expect(overflow.isCollapsed(1)).toBe(false);
    });

    it('detects overflow from out-of-bounds child layout', async () => {
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
