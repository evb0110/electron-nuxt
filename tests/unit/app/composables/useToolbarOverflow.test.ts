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
import { cast } from '@tests/helpers/cast';

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

class FakeElement {
    public children: unknown[] = [];
    private _clientWidth = 0;
    private _scrollWidth = 0;
    public rectLeft = 0;

    constructor(width: number, scrollWidth: number, rectLeft = 0) {
        this._clientWidth = width;
        this._scrollWidth = scrollWidth;
        this.rectLeft = rectLeft;
    }

    get clientWidth() {
        return this._clientWidth;
    }

    set clientWidth(value: number) {
        this._clientWidth = value;
    }

    get scrollWidth() {
        return this._scrollWidth;
    }

    set scrollWidth(value: number) {
        this._scrollWidth = value;
    }

    querySelector<T = FakeElement>(_selector: string): T | null {
        return null;
    }

    querySelectorAll<T = FakeElement>(_selector: string): T[] {
        return this.children as T[];
    }

    getBoundingClientRect() {
        return {
            left: this.rectLeft,
            right: this.rectLeft + this.clientWidth,
            width: this.clientWidth,
        };
    }
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

    it('does not repeatedly retry a failed expand when the narrower tier changes measured width', async () => {
        const { useToolbarOverflow } = await import('@app/composables/useToolbarOverflow');
        const overflow = useToolbarOverflow();
        const tierChanges: number[] = [];

        watch(overflow.collapseTier, value => tierChanges.push(value));

        class ResponsiveToolbarElement extends FakeElement {
            constructor() {
                super(500, 500);
            }

            override get clientWidth() {
                return overflow.collapseTier.value === 0 ? 490 : 500;
            }

            override get scrollWidth() {
                return 500;
            }
        }

        overflow.collapseTier.value = 1;
        overflow.toolbarRef.value = cast<HTMLElement>(new ResponsiveToolbarElement());
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
