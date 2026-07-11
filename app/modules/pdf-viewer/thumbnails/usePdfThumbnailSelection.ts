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

interface IUsePdfThumbnailSelectionOptions {
    consumeClickSkip: () => boolean;
    currentPage: ComputedRef<number>;
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
    scrollPageIntoKeyboardView: (page: number) => void;
    selectedPages: ComputedRef<number[]>;
    totalPages: ComputedRef<number>;
}

export const usePdfThumbnailSelection = (options: IUsePdfThumbnailSelectionOptions) => {
    const {
        consumeClickSkip,
        currentPage,
        isDragging,
        isExternalDragOver,
        markUserInteraction,
        onContextMenu,
        onGoToPage,
        onSelectedPagesChange,
        scrollPageIntoKeyboardView,
        selectedPages,
        totalPages,
    } = options;

    const multiSelection = useMultiSelection<number>();
    const selectionFocusPage = ref<number | null>(null);
    const selectedPagesSet = computed(() => new Set(selectedPages.value));

    function clampPage(page: number) {
        return Math.min(Math.max(1, page), Math.max(1, totalPages.value));
    }

    function isSelected(page: number) {
        return selectedPagesSet.value.has(page);
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

    function handleContainerKeyDown(event: KeyboardEvent) {
        if (
            !event.shiftKey
            || event.altKey
            || event.metaKey
            || event.ctrlKey
            || totalPages.value <= 0
            || isDragging.value
            || isExternalDragOver.value
        ) {
            return;
        }

        const direction = (() => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                return -1;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                return 1;
            }
            return 0;
        })();

        if (direction === 0) {
            return;
        }

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
        scrollPageIntoKeyboardView(nextFocusPage);
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
        },
        {immediate: true},
    );

    return {
        handleContainerKeyDown,
        handleThumbnailClick,
        handleThumbnailContextMenu,
        isSelected,
        toggleSinglePageSelection,
    };
};
