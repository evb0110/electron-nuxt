import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { SIDEBAR } from '@app/constants/pdf-layout';

const mocks = vi.hoisted(() => ({useEventListener: vi.fn()}));

vi.mock('@vueuse/core', () => ({useEventListener: mocks.useEventListener}));
vi.mock('@app/utils/browser-logger', () => ({BrowserLogger: {warn: vi.fn()}}));

function cast<T>(value: unknown): T {
    return value as T;
}

describe('useSidebarResize', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubGlobal('window', {});
    });

    it('clamps the sidebar at the minimum width instead of closing it', async () => {
        const handlers = new Map<string, (event: PointerEvent) => void>();
        const cleanups = [
            vi.fn(),
            vi.fn(),
            vi.fn(),
        ];

        mocks.useEventListener.mockImplementation((_target, event, handler) => {
            handlers.set(String(event), handler as (event: PointerEvent) => void);
            return cleanups.shift() ?? vi.fn();
        });

        const showSidebar = ref(true);
        const { useSidebarResize } = await import('@app/modules/workspace-shell/composables/useSidebarResize');
        const resize = useSidebarResize({ showSidebar });

        resize.startSidebarResize(cast<PointerEvent>({
            clientX: 400,
            preventDefault: vi.fn(),
        }));

        handlers.get('pointermove')?.(cast<PointerEvent>({clientX: 0}));

        expect(resize.sidebarWidth.value).toBe(SIDEBAR.MIN_WIDTH);
        expect(showSidebar.value).toBe(true);
        expect(resize.isResizingSidebar.value).toBe(true);

        handlers.get('pointerup')?.(cast<PointerEvent>({}));

        expect(resize.isResizingSidebar.value).toBe(false);
    });

    it('clamps the sidebar at the maximum width during drag', async () => {
        const handlers = new Map<string, (event: PointerEvent) => void>();
        mocks.useEventListener.mockImplementation((_target, event, handler) => {
            handlers.set(String(event), handler as (event: PointerEvent) => void);
            return vi.fn();
        });

        const showSidebar = ref(true);
        const { useSidebarResize } = await import('@app/modules/workspace-shell/composables/useSidebarResize');
        const resize = useSidebarResize({ showSidebar });

        resize.startSidebarResize(cast<PointerEvent>({
            clientX: 400,
            preventDefault: vi.fn(),
        }));

        handlers.get('pointermove')?.(cast<PointerEvent>({clientX: 10_000}));

        expect(resize.sidebarWidth.value).toBe(SIDEBAR.MAX_WIDTH);
        expect(resize.sidebarWrapperStyle.value.width).toBe(`${SIDEBAR.MAX_WIDTH + SIDEBAR.RESIZER_WIDTH}px`);
    });

    it('ignores resize starts while the sidebar is closed', async () => {
        const showSidebar = ref(false);
        const { useSidebarResize } = await import('@app/modules/workspace-shell/composables/useSidebarResize');
        const resize = useSidebarResize({ showSidebar });
        const preventDefault = vi.fn();

        resize.startSidebarResize(cast<PointerEvent>({
            clientX: 400,
            preventDefault,
        }));

        expect(preventDefault).not.toHaveBeenCalled();
        expect(resize.isResizingSidebar.value).toBe(false);
        expect(resize.sidebarWidth.value).toBe(SIDEBAR.DEFAULT_WIDTH);
    });
});
