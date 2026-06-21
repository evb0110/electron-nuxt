import type { Ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import type {
    IBookmarkItem,
    IBookmarkMenuPayload,
} from '@app/types/pdfOutline';
import {
    findBookmarkById,
    findBookmarkLocation,
    normalizeBookmarkColor,
} from '@app/utils/pdfOutlineHelpers';
import { usePositionedMenu } from '@app/composables/usePositionedMenu';

export const usePdfOutlineContextMenu = (
    bookmarks: Ref<IBookmarkItem[]>,
    isEditMode: Ref<boolean>,
    styleRangeStartId: Ref<string | null>,
    emitBookmarksChange: () => void,
    onEscape: () => void,
) => {
    const { t } = useTypedI18n();
    const windowTarget = typeof window === 'undefined' ? undefined : window;

    interface IBookmarkContextMenuState {
        visible: boolean;
        x: number;
        y: number;
        itemId: string | null;
    }

    interface IBookmarkStyleRange {
        list: IBookmarkItem[];
        start: number;
        end: number;
        count: number;
    }

    function createInitialBookmarkContextMenuState(): IBookmarkContextMenuState {
        return {
            visible: false,
            x: 0,
            y: 0,
            itemId: null,
        };
    }
    const {
        menu: bookmarkContextMenu,
        showPositionedMenu,
        resetMenu,
    } = usePositionedMenu<IBookmarkContextMenuState>(
        '.bookmarks-context-menu',
        createInitialBookmarkContextMenuState,
        { autoDismiss: {
            onOutsideClick: true,
            onResize: true,
            onScroll: true,
        } },
    );

    const selectedContextBookmark = computed(() => {
        const id = bookmarkContextMenu.value.itemId;
        if (!id) {
            return null;
        }

        return findBookmarkById(bookmarks.value, id);
    });

    const styleRangeInfo = computed<IBookmarkStyleRange | null>(() => {
        const selected = selectedContextBookmark.value;
        const startId = styleRangeStartId.value;
        if (!selected || !startId) {
            return null;
        }

        const startLocation = findBookmarkLocation(bookmarks.value, startId);
        const endLocation = findBookmarkLocation(bookmarks.value, selected.id);
        if (!startLocation || !endLocation || startLocation.list !== endLocation.list) {
            return null;
        }

        const start = Math.min(startLocation.index, endLocation.index);
        const end = Math.max(startLocation.index, endLocation.index);

        return {
            list: startLocation.list,
            start,
            end,
            count: end - start + 1,
        };
    });

    const canApplyStyleRange = computed(() => Boolean(styleRangeInfo.value));

    const applyStyleRangeLabel = computed(() => {
        const info = styleRangeInfo.value;
        if (!info) {
            return t('bookmarks.applyStyleRange');
        }
        return t('bookmarks.applyStyleToCount', { count: info.count });
    });

    function openBookmarkContextMenu(payload: IBookmarkMenuPayload) {
        if (!isEditMode.value) {
            return;
        }

        const fallbackWidth = 320;
        const fallbackHeight = 380;
        showPositionedMenu({
            x: payload.x,
            y: payload.y,
            fallbackWidth,
            fallbackHeight,
            buildState: position => ({
                visible: true,
                x: position.x,
                y: position.y,
                itemId: payload.id,
            }),
        });
    }

    function closeBookmarkContextMenu() {
        if (!bookmarkContextMenu.value.visible) {
            return;
        }

        resetMenu();
    }

    function setStyleRangeStart(id: string) {
        styleRangeStartId.value = id;
    }

    function applyBookmarkContextStyle(target: IBookmarkItem, selected: IBookmarkItem) {
        const nextColor = normalizeBookmarkColor(selected.color);
        if (
            target.bold === selected.bold
            && target.italic === selected.italic
            && target.color === nextColor
        ) {
            return false;
        }

        target.bold = selected.bold;
        target.italic = selected.italic;
        target.color = nextColor;
        return true;
    }

    function applyBookmarkContextStyleToRange(selected: IBookmarkItem, range: IBookmarkStyleRange) {
        let changed = false;
        for (let index = range.start; index <= range.end; index += 1) {
            const target = range.list[index];
            if (!target) {
                continue;
            }

            changed = applyBookmarkContextStyle(target, selected) || changed;
        }

        return changed;
    }

    function applyContextStyleToRange() {
        const selected = selectedContextBookmark.value;
        const range = styleRangeInfo.value;
        if (!selected || !range) {
            return;
        }

        const changed = applyBookmarkContextStyleToRange(selected, range);
        if (changed) {
            emitBookmarksChange();
        }
    }

    function handleGlobalKeydown(event: KeyboardEvent) {
        if (event.key !== 'Escape') {
            return;
        }

        const hasActiveOutlineContext = bookmarkContextMenu.value.visible || styleRangeStartId.value !== null;
        if (!hasActiveOutlineContext) {
            return;
        }

        closeBookmarkContextMenu();
        styleRangeStartId.value = null;
        onEscape();
    }
    useEventListener(windowTarget, 'keydown', handleGlobalKeydown);

    return {
        bookmarkContextMenu,
        selectedContextBookmark,
        canApplyStyleRange,
        applyStyleRangeLabel,
        openBookmarkContextMenu,
        closeBookmarkContextMenu,
        setStyleRangeStart,
        applyContextStyleToRange,
    };
};
