import type {
    ComputedRef,
    Ref,
} from 'vue';
import { range } from 'es-toolkit/math';
import { useMultiSelection } from '@app/composables/useMultiSelection';
import {
    arePageNumberListsEqual,
    normalizeSelectedPageNumbers,
    resolveThumbnailContextMenuPages,
    shouldSelectPageFromThumbnailClick,
} from '@app/utils/pdfPageSelection';

/** Rows PageUp/PageDown skip, matching the scan-cleanup rail. */
const PAGE_KEYBOARD_STEP = 5;

const NESTED_CONTROL_SELECTOR = 'button, input, select, textarea, a[href], [role="button"]';

/**
 * Keyboard events raised by a control nested inside a row belong to that
 * control: the rail must not also navigate or move its roving focus.
 */
function isNestedRowControl(target: EventTarget | null) {
    return target instanceof Element && target.closest(NESTED_CONTROL_SELECTOR) !== null;
}

function resolveRowPageFromElement(target: EventTarget | null) {
    if (!(target instanceof Element)) {
        return null;
    }
    const page = Number(target.closest<HTMLElement>('[data-page]')?.dataset.page);
    return Number.isInteger(page) ? page : null;
}

interface IUsePdfThumbnailSelectionOptions {
    consumeClickSkip: () => boolean;
    currentPage: ComputedRef<number>;
    focusPageElement: (page: number) => void;
    isDragging: Ref<boolean>;
    isExternalDragOver: Ref<boolean>;
    markUserInteraction: (reason: string) => void;
    onContextMenu: (payload: {
        clientX: number;
        clientY: number;
        pages: number[];
    }) => void;
    onGoToPage: (page: number) => void;
    onSelectedPagesChange: (pages: number[]) => void;
    renderedPages: ComputedRef<number[]>;
    scrollPageIntoKeyboardView: (page: number) => void;
    selectedPages: ComputedRef<number[]>;
    totalPages: ComputedRef<number>;
}

export const usePdfThumbnailSelection = (options: IUsePdfThumbnailSelectionOptions) => {
    const {
        consumeClickSkip,
        currentPage,
        focusPageElement,
        isDragging,
        isExternalDragOver,
        markUserInteraction,
        onContextMenu,
        onGoToPage,
        onSelectedPagesChange,
        renderedPages,
        scrollPageIntoKeyboardView,
        selectedPages,
        totalPages,
    } = options;

    const multiSelection = useMultiSelection<number>();
    const selectionFocusPage = ref<number | null>(null);
    const keyboardFocusPage = ref<number | null>(null);
    const selectedPagesSet = computed(() => new Set(selectedPages.value));

    function clampPage(page: number) {
        return Math.min(Math.max(1, page), Math.max(1, totalPages.value));
    }

    function isSelected(page: number) {
        return selectedPagesSet.value.has(page);
    }

    /**
     * The single row that carries `tabindex=0`. Keyboard focus is deliberately
     * independent of selection, and it is clamped into the virtualized window
     * so the rail always keeps exactly one tab stop even after the user has
     * scrolled the focused row out of the rendered range.
     */
    const rovingFocusPage = computed(() => {
        const pages = renderedPages.value;
        const firstRenderedPage = pages[0];
        const lastRenderedPage = pages.at(-1);
        if (firstRenderedPage === undefined || lastRenderedPage === undefined) {
            return null;
        }

        const target = keyboardFocusPage.value ?? clampPage(currentPage.value);
        return Math.min(Math.max(target, firstRenderedPage), lastRenderedPage);
    });

    function focusThumbnailPage(page: number) {
        keyboardFocusPage.value = page;
        scrollPageIntoKeyboardView(page);
        focusPageElement(page);
    }

    function handleContainerFocusIn(event: FocusEvent) {
        const page = resolveRowPageFromElement(event.target);
        if (page !== null && page >= 1 && page <= totalPages.value) {
            keyboardFocusPage.value = page;
        }
    }

    function getThumbnailSelectionFallbackAnchor() {
        if (totalPages.value <= 0) {
            return null;
        }
        return clampPage(currentPage.value);
    }

    function handleThumbnailClick(event: MouseEvent, page: number) {
        if (consumeClickSkip()) {
            return;
        }

        keyboardFocusPage.value = page;
        if (!shouldSelectPageFromThumbnailClick(event)) {
            onGoToPage(page);
            return;
        }

        const allPages = range(1, totalPages.value + 1);
        multiSelection.toggle(page, allPages, {
            shift: event.shiftKey,
            meta: event.metaKey || event.ctrlKey,
            fallbackAnchor: event.shiftKey ? getThumbnailSelectionFallbackAnchor() : null,
        });
        selectionFocusPage.value = page;
        const normalized = normalizeSelectedPageNumbers(
            Array.from(multiSelection.selected.value),
            totalPages.value,
        );
        onSelectedPagesChange(normalized);
    }

    function toggleSinglePageSelection(page: number) {
        const nextSelection = new Set(selectedPages.value);
        if (nextSelection.has(page)) {
            nextSelection.delete(page);
        } else {
            nextSelection.add(page);
        }
        multiSelection.selected.value = nextSelection;
        multiSelection.anchor.value = page;
        selectionFocusPage.value = page;
        onSelectedPagesChange(normalizeSelectedPageNumbers(
            Array.from(nextSelection),
            totalPages.value,
        ));
    }

    function handleThumbnailContextMenu(event: MouseEvent, page: number) {
        const pages = resolveThumbnailContextMenuPages(
            page,
            selectedPages.value,
            totalPages.value,
        );
        onContextMenu({
            clientX: event.clientX,
            clientY: event.clientY,
            pages,
        });
    }

    function getKeyboardSelectionBasePage() {
        if (
            selectionFocusPage.value !== null
            && selectionFocusPage.value >= 1
            && selectionFocusPage.value <= totalPages.value
        ) {
            return selectionFocusPage.value;
        }

        const normalized = normalizeSelectedPageNumbers(selectedPages.value, totalPages.value);
        return normalized.at(-1) ?? clampPage(currentPage.value);
    }

    function getKeyboardSelectionAnchorPage(basePage: number) {
        if (
            multiSelection.anchor.value !== null
            && multiSelection.anchor.value >= 1
            && multiSelection.anchor.value <= totalPages.value
        ) {
            return multiSelection.anchor.value;
        }

        const normalized = normalizeSelectedPageNumbers(selectedPages.value, totalPages.value);
        return normalized[0] ?? basePage;
    }

    function resolveArrowDirection(key: string) {
        if (key === 'ArrowUp' || key === 'ArrowLeft') {
            return -1;
        }
        if (key === 'ArrowDown' || key === 'ArrowRight') {
            return 1;
        }
        return 0;
    }

    function extendSelectionByArrow(event: KeyboardEvent, direction: number) {
        event.preventDefault();
        markUserInteraction('keyboard-selection');

        const basePage = getKeyboardSelectionBasePage();
        const nextFocusPage = clampPage(basePage + direction);
        const anchorPage = getKeyboardSelectionAnchorPage(basePage);
        const allPages = range(1, totalPages.value + 1);

        multiSelection.anchor.value = anchorPage;
        multiSelection.toggle(nextFocusPage, allPages, {shift: true});
        selectionFocusPage.value = nextFocusPage;

        const normalized = normalizeSelectedPageNumbers(
            Array.from(multiSelection.selected.value),
            totalPages.value,
        );
        onSelectedPagesChange(normalized);
        onGoToPage(nextFocusPage);
        focusThumbnailPage(nextFocusPage);
    }

    function resolveKeyboardFocusTarget(key: string, basePage: number) {
        const direction = resolveArrowDirection(key);
        if (direction !== 0) {
            return basePage + direction;
        }
        if (key === 'PageUp') {
            return basePage - PAGE_KEYBOARD_STEP;
        }
        if (key === 'PageDown') {
            return basePage + PAGE_KEYBOARD_STEP;
        }
        if (key === 'Home') {
            return 1;
        }
        if (key === 'End') {
            return totalPages.value;
        }
        return null;
    }

    function isActivationKey(key: string) {
        return key === 'Enter' || key === ' ' || key === 'Spacebar';
    }

    function handleContainerKeyDown(event: KeyboardEvent) {
        if (
            event.altKey
            || event.metaKey
            || event.ctrlKey
            || totalPages.value <= 0
            || isDragging.value
            || isExternalDragOver.value
            || isNestedRowControl(event.target)
        ) {
            return;
        }

        if (event.shiftKey) {
            const direction = resolveArrowDirection(event.key);
            if (direction !== 0) {
                extendSelectionByArrow(event, direction);
            }
            return;
        }

        const focusedPage = rovingFocusPage.value;
        if (focusedPage === null) {
            return;
        }
        if (isActivationKey(event.key)) {
            event.preventDefault();
            markUserInteraction('keyboard-activate');
            onGoToPage(focusedPage);
            return;
        }

        const target = resolveKeyboardFocusTarget(event.key, focusedPage);
        if (target === null) {
            return;
        }

        event.preventDefault();
        markUserInteraction('keyboard-focus');
        focusThumbnailPage(clampPage(target));
    }

    function syncInternalSelection(normalized: number[]) {
        multiSelection.selected.value = new Set(normalized);

        if (normalized.length === 0) {
            multiSelection.anchor.value = null;
            selectionFocusPage.value = null;
            return;
        }

        if (
            multiSelection.anchor.value === null ||
            !normalized.includes(multiSelection.anchor.value)
        ) {
            multiSelection.anchor.value = normalized[normalized.length - 1] ?? null;
        }
        if (
            selectionFocusPage.value === null ||
            !normalized.includes(selectionFocusPage.value)
        ) {
            selectionFocusPage.value = normalized[normalized.length - 1] ?? null;
        }
    }

    watch(
        [
            () => selectedPages.value.join(','),
            totalPages,
        ],
        () => {
            const pages = selectedPages.value;
            const normalized = normalizeSelectedPageNumbers(pages, totalPages.value);
            if (!arePageNumberListsEqual(normalized, pages)) {
                onSelectedPagesChange(normalized);
            }

            syncInternalSelection(normalized);
            if (keyboardFocusPage.value !== null) {
                keyboardFocusPage.value = totalPages.value <= 0 ? null : clampPage(keyboardFocusPage.value);
            }
        },
        {immediate: true},
    );

    return {
        handleContainerFocusIn,
        handleContainerKeyDown,
        handleThumbnailClick,
        handleThumbnailContextMenu,
        isSelected,
        rovingFocusPage,
        toggleSinglePageSelection,
    };
};
