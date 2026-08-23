// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    nextTick,
    ref,
} from 'vue';
import { usePdfThumbnailSelection } from '@app/modules/pdf-viewer/thumbnails/usePdfThumbnailSelection';

function createSelectionHarness(options: {
    currentPage?: number;
    renderedPages?: number[];
    totalPages?: number;
} = {}) {
    const totalPages = ref(options.totalPages ?? 5);
    const currentPage = ref(options.currentPage ?? 2);
    const renderedPages = ref(options.renderedPages ?? [
        1,
        2,
        3,
        4,
        5,
    ]);
    const selectedPages = ref([
        2,
        4,
    ]);
    const onSelectedPagesChange = vi.fn((pages: number[]) => {
        selectedPages.value = pages;
    });
    const focusPageElement = vi.fn();
    const onGoToPage = vi.fn();
    const scrollPageIntoKeyboardView = vi.fn();
    const selection = usePdfThumbnailSelection({
        consumeClickSkip: () => false,
        currentPage: computed(() => currentPage.value),
        focusPageElement,
        isDragging: ref(false),
        isExternalDragOver: ref(false),
        markUserInteraction: vi.fn(),
        onContextMenu: vi.fn(),
        onGoToPage,
        onSelectedPagesChange,
        renderedPages: computed(() => renderedPages.value),
        scrollPageIntoKeyboardView,
        selectedPages: computed(() => selectedPages.value),
        totalPages: computed(() => totalPages.value),
    });
    return {
        currentPage,
        focusPageElement,
        onGoToPage,
        onSelectedPagesChange,
        renderedPages,
        scrollPageIntoKeyboardView,
        selection,
        selectedPages,
        totalPages,
    };
}

function keyEvent(key: string, init: KeyboardEventInit = {}) {
    return new KeyboardEvent('keydown', {
        key,
        cancelable: true,
        ...init,
    });
}

describe('usePdfThumbnailSelection', () => {
    it('renormalizes selected pages when total pages shrinks', async () => {
        const {
            onSelectedPagesChange,
            selectedPages,
            totalPages,
        } = createSelectionHarness();
        onSelectedPagesChange.mockClear();

        totalPages.value = 3;
        await nextTick();

        expect(onSelectedPagesChange).toHaveBeenCalledWith([2]);
        expect(selectedPages.value).toEqual([2]);
    });

    it('roves the tab stop from the current page and clamps it into the rendered window', () => {
        const {
            renderedPages,
            selection,
        } = createSelectionHarness({currentPage: 2});

        expect(selection.rovingFocusPage.value).toBe(2);

        renderedPages.value = [
            7,
            8,
            9,
        ];
        expect(selection.rovingFocusPage.value).toBe(7);

        renderedPages.value = [];
        expect(selection.rovingFocusPage.value).toBeNull();

        renderedPages.value = [
            10,
            11,
            12,
        ];
        expect(selection.rovingFocusPage.value).toBe(10);
    });

    it('moves keyboard focus with arrow keys without changing selection or the page', () => {
        const {
            focusPageElement,
            onGoToPage,
            onSelectedPagesChange,
            scrollPageIntoKeyboardView,
            selectedPages,
            selection,
        } = createSelectionHarness({currentPage: 2});
        onSelectedPagesChange.mockClear();

        const event = keyEvent('ArrowDown');
        selection.handleContainerKeyDown(event);

        expect(event.defaultPrevented).toBe(true);
        expect(selection.rovingFocusPage.value).toBe(3);
        expect(scrollPageIntoKeyboardView).toHaveBeenCalledWith(3);
        expect(focusPageElement).toHaveBeenCalledWith(3);
        expect(onSelectedPagesChange).not.toHaveBeenCalled();
        expect(selectedPages.value).toEqual([
            2,
            4,
        ]);
        expect(onGoToPage).not.toHaveBeenCalled();
    });

    it('clamps arrow focus at the document edges and supports Home, End and paging keys', () => {
        const {selection} = createSelectionHarness({
            currentPage: 1,
            renderedPages: [
                1,
                2,
                3,
                4,
                5,
                6,
                7,
                8,
                9,
                10,
            ],
            totalPages: 10,
        });

        selection.handleContainerKeyDown(keyEvent('ArrowUp'));
        expect(selection.rovingFocusPage.value).toBe(1);

        selection.handleContainerKeyDown(keyEvent('End'));
        expect(selection.rovingFocusPage.value).toBe(10);

        selection.handleContainerKeyDown(keyEvent('PageUp'));
        expect(selection.rovingFocusPage.value).toBe(5);

        selection.handleContainerKeyDown(keyEvent('PageDown'));
        expect(selection.rovingFocusPage.value).toBe(10);

        selection.handleContainerKeyDown(keyEvent('Home'));
        expect(selection.rovingFocusPage.value).toBe(1);
    });

    it('activates the focused row with Enter and Space without selecting it', () => {
        const {
            onGoToPage,
            onSelectedPagesChange,
            selection,
        } = createSelectionHarness({currentPage: 2});
        onSelectedPagesChange.mockClear();

        selection.handleContainerKeyDown(keyEvent('ArrowDown'));
        const enter = keyEvent('Enter');
        selection.handleContainerKeyDown(enter);
        expect(enter.defaultPrevented).toBe(true);
        expect(onGoToPage).toHaveBeenLastCalledWith(3);

        const space = keyEvent(' ');
        selection.handleContainerKeyDown(space);
        expect(space.defaultPrevented).toBe(true);
        expect(onGoToPage).toHaveBeenCalledTimes(2);
        expect(onSelectedPagesChange).not.toHaveBeenCalled();
    });

    it('keeps Shift+Arrow range selection and moves the roving focus with it', () => {
        const {
            focusPageElement,
            onGoToPage,
            onSelectedPagesChange,
            selectedPages,
            selection,
        } = createSelectionHarness({currentPage: 2});
        onSelectedPagesChange.mockClear();

        const event = keyEvent('ArrowDown', {shiftKey: true});
        selection.handleContainerKeyDown(event);

        expect(event.defaultPrevented).toBe(true);
        expect(selectedPages.value).toEqual([
            4,
            5,
        ]);
        expect(onGoToPage).toHaveBeenCalledWith(5);
        expect(focusPageElement).toHaveBeenCalledWith(5);
        expect(selection.rovingFocusPage.value).toBe(5);
    });

    it('ignores key presses raised by controls nested inside a row', () => {
        const {
            onGoToPage,
            selection,
        } = createSelectionHarness({currentPage: 2});
        const row = document.createElement('div');
        row.dataset.page = '2';
        const toggle = document.createElement('button');
        row.append(toggle);
        document.body.append(row);

        try {
            const enter = keyEvent('Enter');
            Object.defineProperty(enter, 'target', {value: toggle});
            selection.handleContainerKeyDown(enter);

            const arrow = keyEvent('ArrowDown');
            Object.defineProperty(arrow, 'target', {value: toggle});
            selection.handleContainerKeyDown(arrow);

            expect(enter.defaultPrevented).toBe(false);
            expect(arrow.defaultPrevented).toBe(false);
            expect(onGoToPage).not.toHaveBeenCalled();
            expect(selection.rovingFocusPage.value).toBe(2);
        } finally {
            row.remove();
        }
    });

    it('ignores keyboard navigation before the virtualized window has rows', () => {
        const {
            focusPageElement,
            onGoToPage,
            renderedPages,
            scrollPageIntoKeyboardView,
            selection,
        } = createSelectionHarness({currentPage: 2});
        renderedPages.value = [];

        const event = keyEvent('ArrowDown');
        selection.handleContainerKeyDown(event);

        expect(event.defaultPrevented).toBe(false);
        expect(focusPageElement).not.toHaveBeenCalled();
        expect(scrollPageIntoKeyboardView).not.toHaveBeenCalled();
        expect(onGoToPage).not.toHaveBeenCalled();
    });

    it('adopts the focused row when focus enters the rail', () => {
        const {selection} = createSelectionHarness({currentPage: 2});
        const row = document.createElement('div');
        row.dataset.page = '4';
        const label = document.createElement('span');
        row.append(label);

        selection.handleContainerFocusIn(new FocusEvent('focusin'));
        expect(selection.rovingFocusPage.value).toBe(2);

        const event = new FocusEvent('focusin');
        Object.defineProperty(event, 'target', {value: label});
        selection.handleContainerFocusIn(event);

        expect(selection.rovingFocusPage.value).toBe(4);
    });

    it('leaves navigation keys alone while a modifier chord is held', () => {
        const {
            focusPageElement,
            selection,
        } = createSelectionHarness({currentPage: 2});

        for (const modifier of [
            'ctrlKey',
            'metaKey',
            'altKey',
        ]) {
            const event = keyEvent('ArrowDown', {[modifier]: true});
            selection.handleContainerKeyDown(event);
            expect(event.defaultPrevented).toBe(false);
        }

        expect(focusPageElement).not.toHaveBeenCalled();
        expect(selection.rovingFocusPage.value).toBe(2);
    });
});
