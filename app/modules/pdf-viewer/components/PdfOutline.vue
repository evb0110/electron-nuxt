<template>
    <div class="pdf-bookmarks flex flex-col gap-3">
        <DocumentBookmarkToolbar
            v-if="isBookmarkToolbarVisible"
            :display-mode="displayMode"
            editable
            :is-edit-mode="isEditMode"
            :selected-delete-count="selectedBookmarkDeleteCount"
            @set-display-mode="setDisplayMode"
            @toggle-edit-mode="toggleEditMode"
            @add-root-bookmark="addRootBookmark"
            @remove-selected-bookmarks="removeSelectedBookmarks"
        />

        <div
            v-if="bookmarkStatus === 'loading'"
            class="pdf-bookmarks-loading"
        >
            <AppSpinner size="md" tone="muted" />
            <span>{{ t('bookmarks.loading') }}</span>
        </div>

        <DocumentPanelEmptyState
            v-else-if="bookmarkStatus === 'error'"
            icon="i-ph-warning"
            :title="t('bookmarks.unavailable')"
        />

        <DocumentPanelEmptyState
            v-else-if="bookmarkStatus === 'empty'"
            icon="i-ph-book-open"
            :title="t('bookmarks.noBookmarks')"
        >
            <template v-if="isEditMode" #action>
                <UButton
                    type="button"
                    icon="i-ph-plus"
                    size="xs"
                    variant="soft"
                    color="neutral"
                    :label="t('bookmarks.addFirst')"
                    :aria-label="t('bookmarks.addFirst')"
                    @click="addRootBookmark"
                />
            </template>
        </DocumentPanelEmptyState>

        <div
            v-else-if="isEditMode"
            class="pdf-bookmarks-tree flex flex-col app-scrollbar app-scroll-region--balanced"
            @click="closeBookmarkContextMenu"
        >
            <PdfOutlineItem
                v-for="(item, index) in bookmarks"
                :key="item.id || index"
                :item="item"
                :pdf-document="props.pdfDocument"
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

        <DocumentBookmarkTree
            v-else
            :items="sharedBookmarkItems"
            :active-id="activeItemId"
            :display-mode="displayMode"
            :expanded-ids="expandedBookmarkIds"
            :active-path-ids="activePathBookmarkIds"
            @activate="activateSharedBookmark"
            @toggle-expand="toggleExpanded"
        />

        <PdfOutlineContextMenu
            :visible="bookmarkContextMenu.visible"
            :x="bookmarkContextMenu.x"
            :y="bookmarkContextMenu.y"
            :bookmark="selectedContextBookmark"
            :style-range-start-id="styleRangeStartId"
            :can-apply-style-range="canApplyStyleRange"
            :apply-style-range-label="applyStyleRangeLabel"
            :remove-label="contextRemoveBookmarkLabel"
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
import type { IPdfBookmarkEntry } from '@app/types/pdfContracts';
import type { IPdfBookmarkChangePayload } from '@app/types/pdfUi';
import type {
    IDocumentBookmarkTreeItem,
    TDocumentBookmarkStatus,
} from '@app/utils/document-viewer/bookmarks/documentBookmarks';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import { isPdfDocumentUsable } from '@app/utils/isPdfDocumentUsable';
import {
    buildOutlineFromBookmarkEntries,
    buildResolvedOutline,
    flattenBookmarks,
    parseOutlineItems,
    resolveActiveBookmarkForPage,
} from '@app/utils/pdfOutlineHelpers';
import { usePdfOutlineSelection } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfOutlineSelection';
import { BrowserLogger } from '@app/utils/browserLogger';
import { usePdfOutlineDragDrop } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfOutlineDragDrop';
import { usePdfOutlineEditing } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfOutlineEditing';
import { usePdfOutlineContextMenu } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfOutlineContextMenu';
import { pdfOutlineTreeKey } from '@app/modules/pdf-viewer/engine/pdf-outline-tree-context/pdfOutlineTreeKey';
import AppSpinner from '@app/components/AppSpinner.vue';
import PdfOutlineContextMenu from '@app/modules/pdf-viewer/components/PdfOutlineContextMenu.vue';
import PdfOutlineItem from '@app/modules/pdf-viewer/components/PdfOutlineItem.vue';
import DocumentPanelEmptyState from '@app/components/document-viewer/DocumentPanelEmptyState.vue';
import DocumentBookmarkToolbar from '@app/components/document-viewer/DocumentBookmarkToolbar.vue';
import DocumentBookmarkTree from '@app/components/document-viewer/DocumentBookmarkTree.vue';
import { navigateToBookmarkDestination } from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/navigateToBookmarkDestination';

interface IProps {
    pdfDocument: PDFDocumentProxy | null;
    currentPage: number;
    isEditMode: boolean;
    bookmarkItems?: IPdfBookmarkEntry[] | undefined;
    bookmarksDirty?: boolean | undefined;
    navigationIntentVersion?: number | undefined;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    goToPage: [page: number, options?: IScrollToPageOptions];
    'bookmarks-change': [payload: IPdfBookmarkChangePayload];
    'update:isEditMode': [value: boolean];
}>();

function goToPage(page: number, options?: IScrollToPageOptions) {
    emit('goToPage', page, options);
}

function toggleEditMode() {
    isEditMode.value = !isEditMode.value;
}

const { t } = useTypedI18n();

const bookmarks = ref<IBookmarkItem[]>([]);
const isLoading = ref(false);
const outlineError = ref(false);
const activeItemId = ref<string | null>(null);
const displayMode = ref<TBookmarkDisplayMode>('current-expanded');
const expandedBookmarkIds = ref<Set<string>>(new Set());
const styleRangeStartId = ref<string | null>(null);

const bookmarkStatus = computed<TDocumentBookmarkStatus>(() => {
    if (isLoading.value) {
        return 'loading';
    }
    if (outlineError.value) {
        return 'error';
    }
    return bookmarks.value.length === 0 ? 'empty' : 'ready';
});
const isBookmarkToolbarVisible = computed(() => (
    bookmarkStatus.value === 'ready' || bookmarkStatus.value === 'empty'
));

const isEditMode = computed({
    get: () => props.isEditMode,
    set: (value: boolean) => emit('update:isEditMode', value),
});

const currentPageRef = computed(() => props.currentPage);

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
const sharedBookmarkItems = computed<IDocumentBookmarkTreeItem[]>(() => {
    function mapItems(items: readonly IBookmarkItem[]): IDocumentBookmarkTreeItem[] {
        return items.map(item => ({
            id: item.id,
            title: item.title,
            pageNumber: item.pageIndex === null ? null : item.pageIndex + 1,
            children: mapItems(item.items),
            bold: item.bold,
            italic: item.italic,
            color: item.color,
        }));
    }

    return mapItems(bookmarks.value);
});

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

let bookmarkNavigationRequestId = 0;
let bookmarkNavigationIntentVersion = props.navigationIntentVersion ?? 0;
const bookmarkNavigationIntentVersionByRequest = new Map<number, number>();

/**
 * Prevents async bookmark resolution from applying to an outline/document that
 * no longer owns the user's navigation intent.
 */
function invalidateBookmarkNavigationRequests() {
    bookmarkNavigationRequestId += 1;
    bookmarkNavigationIntentVersion = props.navigationIntentVersion ?? 0;
    bookmarkNavigationIntentVersionByRequest.clear();
}

function beginBookmarkNavigationRequest() {
    invalidateBookmarkNavigationRequests();
    bookmarkNavigationIntentVersionByRequest.set(
        bookmarkNavigationRequestId,
        props.navigationIntentVersion ?? 0,
    );
    return bookmarkNavigationRequestId;
}

function isBookmarkNavigationRequestCurrent(requestId: number) {
    return requestId === bookmarkNavigationRequestId
        && bookmarkNavigationIntentVersionByRequest.get(requestId) === bookmarkNavigationIntentVersion;
}

watch(
    () => props.navigationIntentVersion,
    (version) => {
        const nextVersion = version ?? 0;
        if (nextVersion === bookmarkNavigationIntentVersion) {
            return;
        }
        bookmarkNavigationIntentVersion = nextVersion;
        invalidateBookmarkNavigationRequests();
    },
    { flush: 'sync' },
);

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
    bookmarkOrderIndexMap,
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

function removeSelectedBookmarks() {
    editing.removeSelectedBookmarks();
}

const selectedBookmarkDeleteCount = computed(() => (
    editing.resolveRootBookmarkIds(selection.selectedBookmarkIds.value).length
));

const contextRemoveBookmarkLabel = computed(() => {
    const contextBookmark = selectedContextBookmark.value;
    if (!contextBookmark) {
        return t('bookmarks.removeBookmark');
    }

    const count = editing.resolveBookmarkRemovalTargetIds(contextBookmark.id).length;
    if (count <= 1) {
        return t('bookmarks.removeBookmark');
    }

    return t('bookmarks.removeSelectedBookmarks', { count });
});

provide(pdfOutlineTreeKey, {
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
    beginBookmarkNavigationRequest,
    isBookmarkNavigationRequestCurrent,
});

let outlineRunId = 0;
const initialBookmarkSnapshot = ref('[]');
const hasMaterializedBookmarkSnapshot = ref(false);

function getPersistedBookmarkSnapshot(items = bookmarks.value) {
    return JSON.stringify(editing.mapBookmarksForPersistence(items));
}

function emitBookmarksChange() {
    const persisted = editing.mapBookmarksForPersistence(bookmarks.value);
    const snapshot = JSON.stringify(persisted);
    emit('bookmarks-change', {
        bookmarks: persisted,
        dirty: snapshot !== initialBookmarkSnapshot.value,
        history: 'record',
    });
}

function setBookmarkBaseline() {
    const persisted = editing.mapBookmarksForPersistence(bookmarks.value);
    initialBookmarkSnapshot.value = JSON.stringify(persisted);
    hasMaterializedBookmarkSnapshot.value = true;
    emit('bookmarks-change', {
        bookmarks: persisted,
        dirty: false,
        history: 'reset',
    });
}

function updateActiveItemFromCurrentPage() {
    const active = resolveActiveBookmarkForPage(
        flatBookmarks.value,
        props.currentPage,
        activeItemId.value,
    );
    activeItemId.value = active?.id ?? null;
    if (!isEditMode.value) {
        if (activeItemId.value) {
            selection.applySingleSelection(activeItemId.value);
        } else {
            selection.clearSelection();
        }
    }
}

function getPendingBookmarkEntries() {
    return props.bookmarksDirty ? props.bookmarkItems ?? [] : null;
}

function shouldApplyExternalBookmarkItems(isDirty: boolean) {
    return isDirty || hasMaterializedBookmarkSnapshot.value;
}

function syncBookmarkBaselineFromCurrentItems() {
    initialBookmarkSnapshot.value = getPersistedBookmarkSnapshot();
    hasMaterializedBookmarkSnapshot.value = true;
}

function applyPendingBookmarkItems(
    entries: IPdfBookmarkEntry[],
    options: { syncBaseline?: boolean } = {},
) {
    outlineError.value = false;
    if (JSON.stringify(entries) === getPersistedBookmarkSnapshot()) {
        if (options.syncBaseline) {
            syncBookmarkBaselineFromCurrentItems();
        } else {
            hasMaterializedBookmarkSnapshot.value = true;
        }
        return;
    }

    invalidateBookmarkNavigationRequests();
    resetBookmarkIdCounter();
    bookmarks.value = buildOutlineFromBookmarkEntries(entries, createBookmarkId);
    closeBookmarkContextMenu();
    editing.cancelEditingBookmark();
    dragDrop.resetDragState();
    styleRangeStartId.value = null;
    selection.clearSelection();
    expandedBookmarkIds.value = new Set();
    updateActiveItemFromCurrentPage();
    if (activeItemId.value) {
        selection.applySingleSelection(activeItemId.value);
    }
    if (options.syncBaseline) {
        syncBookmarkBaselineFromCurrentItems();
    } else {
        hasMaterializedBookmarkSnapshot.value = true;
    }
}

function applyPendingBookmarkItemsIfDirty() {
    const pendingBookmarkEntries = getPendingBookmarkEntries();
    if (!pendingBookmarkEntries) {
        return false;
    }

    isLoading.value = false;
    applyPendingBookmarkItems(pendingBookmarkEntries);
    return true;
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
    if (applyPendingBookmarkItemsIfDirty()) {
        return;
    }

    isLoading.value = false;
    outlineError.value = false;
    bookmarks.value = [];
    activeItemId.value = null;
    selection.clearSelection();
    setBookmarkBaseline();
}

function isStaleOutlineRun(runId: number, pdfDocument: PDFDocumentProxy) {
    return (
        runId !== outlineRunId ||
        props.pdfDocument !== pdfDocument ||
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
    if (applyPendingBookmarkItemsIfDirty()) {
        return;
    }

    outlineError.value = false;
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

    if (applyPendingBookmarkItemsIfDirty()) {
        return;
    }

    BrowserLogger.error('pdfOutline', 'Failed to load bookmarks', error);
    outlineError.value = true;
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
    outlineError.value = false;
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
    const pdfDocument = props.pdfDocument;
    outlineRunId += 1;
    invalidateBookmarkNavigationRequests();
    hasMaterializedBookmarkSnapshot.value = false;
    const runId = outlineRunId;
    resetOutlineInteractionState();

    if (applyPendingBookmarkItemsIfDirty()) {
        return;
    }

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

function activateSharedBookmark(id: string) {
    const item = flatBookmarks.value.find(candidate => candidate.id === id);
    if (!item) {
        return;
    }

    const wasActive = activeItemId.value === item.id;
    handleActivate({
        id: item.id,
        hasChildren: item.items.length > 0,
        wasActive,
        multiSelect: false,
        rangeSelect: false,
    });
    if (wasActive && item.items.length > 0) {
        toggleExpanded(item.id);
        return;
    }

    const navigationRequestId = beginBookmarkNavigationRequest();
    void navigateToBookmarkDestination({
        item,
        pdfDocument: props.pdfDocument,
        navigationRequestId,
        isBookmarkNavigationRequestCurrent,
        emitGoToPage: (page, options) => emit('goToPage', page, options),
    });
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
    () => props.pdfDocument,
    () => loadOutline(),
    { immediate: true },
);

watch(
    [
        () => props.bookmarksDirty ?? false,
        () => props.bookmarkItems,
    ],
    ([
        isDirty,
        externalItems,
    ]) => {
        const items = externalItems ?? [];
        if (shouldApplyExternalBookmarkItems(isDirty)) {
            applyPendingBookmarkItems(items, { syncBaseline: !isDirty });
        }
    },
    {immediate: true},
);

watch(
    () => props.currentPage,
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
    invalidateBookmarkNavigationRequests();
});
</script>

<style scoped>
.pdf-bookmarks {
    height: 100%;
    min-height: 0;
    padding: var(--app-sidebar-content-padding);
}

.pdf-bookmarks-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--app-space-3xl);
    padding: var(--app-space-16xl);
    color: var(--ui-text-muted);
    text-align: center;
}

.pdf-bookmarks-tree {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    user-select: none;
}

.pdf-bookmarks-drop-end {
    height: var(--app-outline-loading-icon-height);
    margin-top: var(--app-space-3xs);
    border-radius: var(--app-radius-md);
}

.pdf-bookmarks-drop-end.is-active {
    background: color-mix(in srgb, var(--ui-primary) 12%, transparent 88%);
    box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--ui-primary) 72%, transparent 28%);
}

</style>
