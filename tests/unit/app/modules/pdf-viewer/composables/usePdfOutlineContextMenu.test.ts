import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { IBookmarkItem } from '@app/types/pdfOutline';

const mocks = vi.hoisted(() => ({ keydownListeners: [] as Array<(event: KeyboardEvent) => void> }));

vi.mock('@vueuse/core', () => ({ useEventListener: vi.fn((
    _target: unknown,
    event: string,
    listener: (event: KeyboardEvent) => void,
) => {
    if (event === 'keydown') {
        mocks.keydownListeners.push(listener);
    }
    return vi.fn();
}) }));

vi.mock('@app/composables/usePositionedMenu', () => ({ usePositionedMenu: <TMenuState>(
    _selector: string,
    createInitialState: () => TMenuState,
) => {
    const menu = ref(createInitialState());
    return {
        menu,
        showPositionedMenu: vi.fn((options: {buildState: (position: {
            x: number;
            y: number;
        }) => TMenuState;}) => {
            menu.value = options.buildState({
                x: 10,
                y: 20,
            });
        }),
        resetMenu: vi.fn(() => {
            menu.value = createInitialState();
        }),
    };
} }));

function createBookmark(id: string): IBookmarkItem {
    return {
        id,
        title: id,
        dest: null,
        pageIndex: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
    };
}

describe('usePdfOutlineContextMenu', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.keydownListeners.length = 0;
        vi.stubGlobal('window', { addEventListener: vi.fn() });
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
    });

    it('ignores app-wide Escape when no outline context state is active', async () => {
        const { usePdfOutlineContextMenu } = await import(
            '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfOutlineContextMenu'
        );
        const onEscape = vi.fn();

        usePdfOutlineContextMenu(
            ref([createBookmark('first')]),
            ref(true),
            ref(null),
            vi.fn(),
            onEscape,
        );

        mocks.keydownListeners[0]?.({ key: 'Escape' } as KeyboardEvent);

        expect(onEscape).not.toHaveBeenCalled();
    });

    it('handles Escape when style range state is active', async () => {
        const { usePdfOutlineContextMenu } = await import(
            '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfOutlineContextMenu'
        );
        const styleRangeStartId = ref<string | null>('first');
        const onEscape = vi.fn();

        usePdfOutlineContextMenu(
            ref([createBookmark('first')]),
            ref(true),
            styleRangeStartId,
            vi.fn(),
            onEscape,
        );

        mocks.keydownListeners[0]?.({ key: 'Escape' } as KeyboardEvent);

        expect(styleRangeStartId.value).toBeNull();
        expect(onEscape).toHaveBeenCalledOnce();
    });
});
