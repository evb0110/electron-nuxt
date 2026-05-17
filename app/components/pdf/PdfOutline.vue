<template>
    <div class="pdf-bookmarks flex flex-col gap-3">
        <PdfOutlineToolbar
            :display-mode="displayMode"
            :is-edit-mode="isEditMode"
            @set-display-mode="setDisplayMode"
            @toggle-edit-mode="toggleEditMode"
            @add-root-bookmark="addRootBookmark"
        />

        <div
            v-if="isLoading"
            class="pdf-bookmarks-loading"
        >
            <AppSpinner size="md" tone="muted" />
            <span>{{ t('bookmarks.loading') }}</span>
        </div>

        <div
            v-else-if="bookmarks.length === 0"
            class="pdf-bookmarks-empty"
        >
            <UIcon name="i-ph-book-open" />
            <span>{{ t('bookmarks.noBookmarks') }}</span>
            <button
                v-if="isEditMode"
                type="button"
                class="pdf-bookmarks-empty-action"
                :aria-label="t('bookmarks.addFirst')"
                @click="addRootBookmark"
            >
                <UIcon
                    name="i-ph-plus"
                    class="size-4"
                />
                <span>{{ t('bookmarks.addFirst') }}</span>
            </button>
        </div>

        <div
            v-else
            class="pdf-bookmarks-tree flex flex-col app-scrollbar"
            @click="closeBookmarkContextMenu"
        >
            <PdfOutlineItem
                v-for="(item, index) in bookmarks"
                :key="item.id || index"
                :item="item"
                :pdf-document="pdfDocument"
                @go-to-page="goToPage"
                @activate="handleActivate"
                @toggle-expand="toggleExpanded"
                @open-actions="openBookmarkContextMenu"
                @save-edit="renameBookmark"
                @cancel-edit="cancelEditingBookmark"
                @drag-start="handleBookmarkDragStart"
                @drag-hover="handleBookmarkDragHover"
                @drop-bookmark="handleBookmarkDrop"
                @drag-end="handleBookmarkDragEnd"
            />
            <div
                v-if="isEditMode"
                class="pdf-bookmarks-drop-end"
                :class="{ 'is-active': dragDrop.isRootAppendDropTarget.value }"
                @dragover.prevent="handleTreeEndDragOver"
                @drop.prevent="handleTreeEndDrop"
            />
        </div>

        <PdfOutlineContextMenu
            :visible="bookmarkContextMenu.visible"
            :x="bookmarkContextMenu.x"
            :y="bookmarkContextMenu.y"
            :bookmark="selectedContextBookmark"
            :style-range-start-id="styleRangeStartId"
            :can-apply-style-range="canApplyStyleRange"
            :apply-style-range-label="applyStyleRangeLabel"
            @edit="startEditingBookmark"
            @add-sibling-above="addSiblingAbove"
            @add-sibling-below="addSiblingBelow"
            @add-child="addChildBookmark"
            @toggle-bold="toggleBookmarkBold"
            @toggle-italic="toggleBookmarkItalic"
            @set-color="setBookmarkColor"
            @set-style-range-start="setStyleRangeStart"
            @apply-style-to-range="applyContextStyleToRange"
            @remove="removeBookmark"
        />
    </div>
</template>

<script setup lang="ts">

import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
    IBookmarkItem,
    IBookmarkActivatePayload,
    IBookmarkDropPayload,
    TBookmarkDisplayMode,
} from '@app/types/pdfOutline';
import type { IPdfBookmarkEntry } from '@app/types/pdf';
import { isPdfDocumentUsable } from '@app/utils/pdfDocumentGuard';
import {
    buildResolvedOutline,
    flattenBookmarks,
    parseOutlineItems,
} from '@app/utils/pdfOutlineHelpers';
import { usePdfOutlineSelection } from '@app/composables/pdf/usePdfOutlineSelection';
import { BrowserLogger } from '@app/utils/browserLogger';
import { usePdfOutlineDragDrop } from '@app/composables/pdf/usePdfOutlineDragDrop';
import { usePdfOutlineEditing } from '@app/composables/pdf/usePdfOutlineEditing';
import { usePdfOutlineContextMenu } from '@app/composables/pdf/usePdfOutlineContextMenu';
import { PDF_OUTLINE_TREE_KEY } from '@app/composables/pdf/usePdfOutlineKeys';
import AppSpinner from '@app/components/AppSpinner.vue';
import PdfOutlineContextMenu from '@app/components/pdf/PdfOutlineContextMenu.vue';
import PdfOutlineItem from '@app/components/pdf/PdfOutlineItem.vue';
import PdfOutlineToolbar from '@app/components/pdf/PdfOutlineToolbar.vue';

interface IProps {
    pdfDocument: PDFDocumentProxy | null;
    currentPage: number;
    isEditMode: boolean;
}

const {
    currentPage,
    isEditMode: isEditModeProp,
    pdfDocument: pdfDocumentProp,
} = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'goToPage', page: number): void;
    (e: 'bookmarks-change', payload: {
        bookmarks: IPdfBookmarkEntry[];
        dirty: boolean;
    }): void;
    (e: 'update:isEditMode', value: boolean): void;
}>();

function goToPage(page: number) {
    emit('goToPage', page);
}

function toggleEditMode() {
    isEditMode.value = !isEditMode.value;
}

const { t } = useTypedI18n();

const bookmarks = ref<IBookmarkItem[]>([]);
const isLoading = ref(false);
const activeItemId = ref<string | null>(null);
const displayMode = ref<TBookmarkDisplayMode>('current-expanded');
const expandedBookmarkIds = ref<Set<string>>(new Set());
const styleRangeStartId = ref<string | null>(null);

const isEditMode = computed({
    get: () => isEditModeProp,
    set: (value: boolean) => emit('update:isEditMode', value),
});

const currentPageRef = computed(() => currentPage);

const parentBookmarkIdMap = computed(() => {
    const map = new Map<string, string | null>();

    function visit(items: IBookmarkItem[], parentId: string | null) {
        for (const item of items) {
            map.set(item.id, parentId);
            visit(item.items, item.id);
        }
    }

    visit(bookmarks.value, null);
    return map;
});

const activePathBookmarkIds = computed(() => {
    const ids = new Set<string>();
    const map = parentBookmarkIdMap.value;
    let cursor = activeItemId.value;

    while (cursor) {
        ids.add(cursor);
        cursor = map.get(cursor) ?? null;
    }

    return ids;
});

let bookmarkIdCounter = 0;

function resetBookmarkIdCounter() {
    bookmarkIdCounter = 0;
}

function createBookmarkId() {
    const id = `bookmark-${bookmarkIdCounter}`;
    bookmarkIdCounter += 1;
    return id;
}

const flatBookmarks = computed(() => flattenBookmarks(bookmarks.value));

const bookmarkOrderIndexMap = computed(() => {
    const map = new Map<string, number>();
    for (const [
        index,
        item,
    ] of flatBookmarks.value.entries()) {
        map.set(item.id, index);
    }
    return map;
});

const selection = usePdfOutlineSelection(
    bookmarks,
    activeItemId,
    displayMode,
    expandedBookmarkIds,
    activePathBookmarkIds,
);

const contextMenuApi = usePdfOutlineContextMenu(
    bookmarks,
    isEditMode,
    styleRangeStartId,
    () => emitBookmarksChange(),
    () => {
        editing.cancelEditingBookmark();
        dragDrop.resetDragState();
    },
);

const {
    bookmarkContextMenu,
    selectedContextBookmark,
    canApplyStyleRange,
    applyStyleRangeLabel,
    openBookmarkContextMenu,
    closeBookmarkContextMenu,
    setStyleRangeStart,
    applyContextStyleToRange,
} = contextMenuApi;

const dragDrop = usePdfOutlineDragDrop(
    bookmarks,
    expandedBookmarkIds,
    isEditMode,
    selection.selectedBookmarkIds,
    parentBookmarkIdMap,
    bookmarkOrderIndexMap,
    selection.applySingleSelection,
    closeBookmarkContextMenu,
);

const editing = usePdfOutlineEditing(
    bookmarks,
    activeItemId,
    expandedBookmarkIds,
    displayMode,
    isEditMode,
    parentBookmarkIdMap,
    selection.selectedBookmarkIds,
    selection.selectionAnchorBookmarkId,
    styleRangeStartId,
    dragDrop.draggingBookmarkIds,
    selection.applySingleSelection,
    closeBookmarkContextMenu,
    dragDrop.resetDragState,
    currentPageRef,
    emitBookmarksChange,
    createBookmarkId,
);

function addRootBookmark() {
    editing.addRootBookmark();
}

function renameBookmark(payload: {
    id: string;
    title: string;
}) {
    editing.renameBookmark(payload);
}

function cancelEditingBookmark() {
    editing.cancelEditingBookmark();
}

function handleBookmarkDragStart(payload: { id: string }) {
    dragDrop.handleBookmarkDragStart(payload);
}

function handleBookmarkDragHover(payload: IBookmarkDropPayload) {
    dragDrop.handleBookmarkDragHover(payload);
}

function handleBookmarkDragEnd() {
    dragDrop.handleBookmarkDragEnd();
}

function handleTreeEndDragOver() {
    dragDrop.handleTreeEndDragOver();
}

function startEditingBookmark(id: string) {
    editing.startEditingBookmark(id);
}

function addSiblingAbove(id: string) {
    editing.addSiblingAbove(id);
}

function addSiblingBelow(id: string) {
    editing.addSiblingBelow(id);
}

function addChildBookmark(id: string) {
    editing.addChildBookmark(id);
}

function toggleBookmarkBold(id: string) {
    editing.toggleBookmarkBold(id);
}

function toggleBookmarkItalic(id: string) {
    editing.toggleBookmarkItalic(id);
}

function setBookmarkColor(payload: {
    id: string;
    color: string | null;
}) {
    editing.setBookmarkColor(payload.id, payload.color);
}

function removeBookmark(id: string) {
    editing.removeBookmark(id);
}

provide(PDF_OUTLINE_TREE_KEY, {
    expandedBookmarkIds,
    activeItemId,
    editingItemId: editing.editingItemId,
    selectedBookmarkIds: selection.selectedBookmarkIds,
    displayMode,
    isEditMode,
    draggingItemIds: dragDrop.draggingBookmarkIds,
    dropTarget: dragDrop.bookmarkDropTarget,
    styleRangeStartId,
    activePathBookmarkIds,
});

let outlineRunId = 0;
const initialBookmarkSnapshot = ref('[]');

function emitBookmarksChange() {
    const persisted = editing.mapBookmarksForPersistence(bookmarks.value);
    const snapshot = JSON.stringify(persisted);
    emit('bookmarks-change', {
        bookmarks: persisted,
        dirty: snapshot !== initialBookmarkSnapshot.value,
    });
}

function setBookmarkBaseline() {
    const persisted = editing.mapBookmarksForPersistence(bookmarks.value);
    initialBookmarkSnapshot.value = JSON.stringify(persisted);
    emit('bookmarks-change', {
        bookmarks: persisted,
        dirty: false,
    });
}

function updateActiveItemFromCurrentPage() {
    const pageIndex = Math.max(0, (currentPage || 1) - 1);
    let active: IBookmarkItem | null = null;

    for (const item of flatBookmarks.value) {
        if (typeof item.pageIndex === 'number' && item.pageIndex <= pageIndex) {
            active = item;
        }
    }

    activeItemId.value = active?.id ?? null;
    if (!isEditMode.value) {
        if (activeItemId.value) {
            selection.applySingleSelection(activeItemId.value);
        } else {
            selection.clearSelection();
        }
    }
}

function resetOutlineInteractionState() {
    closeBookmarkContextMenu();
    editing.cancelEditingBookmark();
    dragDrop.resetDragState();
    styleRangeStartId.value = null;
    selection.clearSelection();
    expandedBookmarkIds.value = new Set();
}

function clearLoadedOutline() {
    isLoading.value = false;
    bookmarks.value = [];
    activeItemId.value = null;
    selection.clearSelection();
    setBookmarkBaseline();
}

function isStaleOutlineRun(runId: number, pdfDocument: PDFDocumentProxy) {
    return (
        runId !== outlineRunId ||
        pdfDocumentProp !== pdfDocument ||
        !isPdfDocumentUsable(pdfDocument)
    );
}

async function resolveBookmarksFromPdf(pdfDocument: PDFDocumentProxy) {
    const result = await pdfDocument.getOutline();
    const rawOutline = parseOutlineItems(result);
    const destinationCache = new Map<string, unknown[] | null>();
    const refIndexCache = new Map<string, number | null>();

    resetBookmarkIdCounter();
    return buildResolvedOutline(
        rawOutline,
        pdfDocument,
        destinationCache,
        refIndexCache,
        createBookmarkId,
    );
}

function applyLoadedBookmarks(resolved: IBookmarkItem[]) {
    bookmarks.value = resolved;
    updateActiveItemFromCurrentPage();
    if (activeItemId.value) {
        selection.applySingleSelection(activeItemId.value);
    }
    setBookmarkBaseline();
}

function handleOutlineLoadError(
    error: unknown,
    runId: number,
    pdfDocument: PDFDocumentProxy,
) {
    if (isStaleOutlineRun(runId, pdfDocument)) {
        return;
    }

    BrowserLogger.error('pdfOutline', 'Failed to load bookmarks', error);
    bookmarks.value = [];
    activeItemId.value = null;
    selection.clearSelection();
    setBookmarkBaseline();
}

function finishOutlineLoading(runId: number) {
    if (runId === outlineRunId) {
        isLoading.value = false;
    }
}

async function loadUsableOutline(pdfDocument: PDFDocumentProxy, runId: number) {
    isLoading.value = true;
    try {
        const resolved = await resolveBookmarksFromPdf(pdfDocument);
        if (!isStaleOutlineRun(runId, pdfDocument)) {
            applyLoadedBookmarks(resolved);
        }
    } catch (error) {
        handleOutlineLoadError(error, runId, pdfDocument);
    } finally {
        finishOutlineLoading(runId);
    }
}

async function loadOutline() {
    const pdfDocument = pdfDocumentProp;
    outlineRunId += 1;
    const runId = outlineRunId;
    resetOutlineInteractionState();

    if (!pdfDocument || !isPdfDocumentUsable(pdfDocument)) {
        clearLoadedOutline();
        return;
    }

    await loadUsableOutline(pdfDocument, runId);
}

function setDisplayMode(mode: TBookmarkDisplayMode) {
    displayMode.value = mode;

    if (mode === 'top-level') {
        expandedBookmarkIds.value = new Set();
    }
}

function handleActivate(payload: IBookmarkActivatePayload) {
    activeItemId.value = payload.id;
    if (isEditMode.value) {
        if (payload.rangeSelect) {
            selection.applyRangeSelection(payload.id);
        } else if (payload.multiSelect) {
            const nextSelection = new Set(selection.selectedBookmarkIds.value);
            if (nextSelection.has(payload.id)) {
                nextSelection.delete(payload.id);
            } else {
                nextSelection.add(payload.id);
            }
            selection.selectedBookmarkIds.value = nextSelection;
            selection.selectionAnchorBookmarkId.value = payload.id;
        } else {
            selection.applySingleSelection(payload.id);
        }
    } else {
        selection.applySingleSelection(payload.id);
    }

    closeBookmarkContextMenu();
}

function toggleExpanded(id: string) {
    if (displayMode.value !== 'top-level') {
        displayMode.value = 'top-level';
    }

    const nextExpanded = new Set(expandedBookmarkIds.value);
    if (nextExpanded.has(id)) {
        nextExpanded.delete(id);
    } else {
        nextExpanded.add(id);
    }
    expandedBookmarkIds.value = nextExpanded;
}

function handleBookmarkDrop(payload: IBookmarkDropPayload) {
    dragDrop.handleBookmarkDrop(payload, activeItemId, emitBookmarksChange);
}

function handleTreeEndDrop() {
    dragDrop.handleTreeEndDrop(activeItemId, emitBookmarksChange);
}

watch(
    () => pdfDocumentProp,
    () => loadOutline(),
    { immediate: true },
);

watch(
    () => currentPage,
    () => updateActiveItemFromCurrentPage(),
);

watch(
    () => isEditMode.value,
    (value) => {
        if (!value) {
            editing.cancelEditingBookmark();
            closeBookmarkContextMenu();
            dragDrop.resetDragState();
            styleRangeStartId.value = null;
            if (activeItemId.value) {
                selection.applySingleSelection(activeItemId.value);
            } else {
                selection.clearSelection();
            }
        }
    },
);

onBeforeUnmount(() => {
    outlineRunId += 1;
});
</script>

<style scoped>
.pdf-bookmarks {
    height: 100%;
    min-height: 0;
    padding: 0.75rem;
}

.pdf-bookmarks-loading,
.pdf-bookmarks-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    color: var(--ui-text-muted);
    text-align: center;
}

.pdf-bookmarks-empty-action {
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-bg);
    color: var(--ui-text-highlighted);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    font-weight: 600;
    padding: 6px 10px;
    cursor: pointer;
}

.pdf-bookmarks-empty-action:hover {
    background: var(--ui-bg-muted);
}

.pdf-bookmarks-tree {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    user-select: none;
}

.pdf-bookmarks-drop-end {
    height: 18px;
    margin-top: 2px;
    border-radius: 6px;
}

.pdf-bookmarks-drop-end.is-active {
    background: color-mix(in srgb, var(--ui-primary) 12%, transparent 88%);
    box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--ui-primary) 72%, transparent 28%);
}

</style>
