<template>
    <AppSidebarShell
        v-show="isOpen"
        class="pdf-sidebar"
        data-testid="document-sidebar"
        :style="sidebarStyle"
        :model-value="activeTab"
        :tabs="localizedTabs"
        :outer-scroll="activeTab === 'annotations'"
        @update:model-value="handleShellTabUpdate"
    >
            <PdfAnnotationsPanel
                v-show="activeTab === 'annotations'"
                :tool="annotationTool"
                :settings="annotationSettings"
                :comments="annotationComments"
                :comments-status="annotationCommentsStatus"
                :active-comment-stable-key="annotationActiveCommentStableKey"
                :keep-active="annotationKeepActive"
                @set-tool="updateAnnotationTool"
                @update:keep-active="updateAnnotationKeepActive"
                @update-setting="updateAnnotationSetting"
                @focus-comment="focusAnnotationComment"
                @open-note="openAnnotationNote"
                @delete-comment="deleteAnnotationComment"
                @place-note="placeAnnotationNote"
            />

            <div
                v-show="activeTab === 'thumbnails'"
                class="pdf-sidebar-pages"
            >
                <PdfPageSelectionBar
                    :selected-count="selectedThumbnailPages.length"
                    :is-operation-in-progress="isPageOperationInProgress ?? false"
                    :is-djvu-mode="isDjvuMode"
                    @rotate-cw="rotateSelectedPagesClockwise"
                    @rotate-ccw="rotateSelectedPagesCounterClockwise"
                    @extract-pages="extractSelectedPages"
                    @export-pages="exportSelectedPages"
                    @delete-pages="deleteSelectedPages"
                    @deselect="clearPageSelection"
                />
                <div class="pdf-sidebar-pages-thumbnails">
                    <PdfThumbnails
                        :pdf-document="pdfDocument"
                        :current-page="currentPage"
                        :total-pages="totalPages"
                        :page-labels="pageLabels"
                        :selected-pages="selectedThumbnailPages"
                        :invalidation-request="thumbnailInvalidationRequest"
                        :hidden-annotation-ids="thumbnailHiddenAnnotationIds"
                        :annotation-comments="annotationComments"
                        :annotation-settings="annotationSettings"
                        :is-active="isOpen && activeTab === 'thumbnails'"
                        :is-resizing="isResizing"
                        @go-to-page="goToPage"
                        @update:selected-pages="handleSelectedPagesUpdate"
                        @page-context-menu="openPageContextMenu"
                        @reorder="reorderPages"
                        @file-drop="dropPageFiles"
                    />
                </div>

                <PdfSidebarPageNumbering
                    :total-pages="totalPages"
                    :selected-pages="selectedThumbnailPages"
                    :page-labels="pageLabels"
                    :page-label-ranges="pageLabelRanges"
                    @update:selected-pages="handleSelectedPagesUpdate"
                    @update:page-label-ranges="updatePageLabelRanges"
                    @clear="clearPageSelection"
                />
            </div>

            <PdfOutline
                v-show="activeTab === 'bookmarks'"
                :pdf-document="pdfDocument"
                :current-page="currentPage"
                :is-edit-mode="bookmarkEditMode"
                :bookmark-items="bookmarkItems"
                :bookmarks-dirty="bookmarksDirty"
                :navigation-intent-version="bookmarkNavigationIntentVersion"
                @go-to-page="goToPage"
                @bookmarks-change="updateBookmarks"
                @update:is-edit-mode="updateBookmarkEditMode"
            />
            <DocumentSearchPanel
                v-show="activeTab === 'search'"
                :session="searchSession"
                :is-active="isOpen && activeTab === 'search'"
                :focus-request="searchFocusRequest ?? 0"
                :page-labels="pageLabels ?? null"
            />
    </AppSidebarShell>
</template>

<script setup lang="ts">

import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IResolvedSearchMatchOptions } from '@contracts/search';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdfContracts';
import type {
    IPdfBookmarkChangePayload,
    IPdfSearchMatch,
} from '@app/types/pdfUi';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    TAnnotationCommentsStatus,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type { TPdfSidebarTab } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types';
import PdfAnnotationsPanel from '@app/modules/pdf-viewer/components/PdfAnnotationsPanel.vue';
import PdfOutline from '@app/modules/pdf-viewer/components/PdfOutline.vue';
import PdfPageSelectionBar from '@app/modules/pdf-viewer/components/PdfPageSelectionBar.vue';
import DocumentSearchPanel from '@app/components/document-viewer/DocumentSearchPanel.vue';
import PdfSidebarPageNumbering from '@app/modules/pdf-viewer/components/PdfSidebarPageNumbering.vue';
import PdfThumbnails from '@app/modules/pdf-viewer/components/PdfThumbnails.vue';
import AppSidebarShell from '@app/components/sidebar/AppSidebarShell.vue';
import { resolveDocumentSidebarTabs } from '@app/utils/document-viewer/sidebar/documentSidebarTabs';
import { createPdfDocumentSearchSession } from '@app/modules/pdf-viewer/search/createPdfDocumentSearchSession';

interface IProps {
    isOpen: boolean;
    isResizing?: boolean | undefined;
    pdfDocument: PDFDocumentProxy | null;
    currentPage: number;
    totalPages: number;
    pageLabels?: string[] | null | undefined;
    pageLabelRanges?: IPdfPageLabelRange[] | undefined;
    searchResults: IPdfSearchMatch[];
    currentResultIndex: number;
    currentResultNavigationId: number;
    searchQuery: string;
    submittedSearchQuery?: string | undefined;
    searchOptions: IResolvedSearchMatchOptions;
    isSearching: boolean;
    searchError?: string | null | undefined;
    searchFocusRequest?: number | undefined;
    searchProgress?: {
        processed: number;
        total: number;
    } | undefined;
    isTruncated?: boolean | undefined;
    minQueryLength?: number | undefined;
    activeTab?: TPdfSidebarTab | undefined;
    width?: number | undefined;
    annotationTool: TAnnotationTool;
    annotationKeepActive: boolean;
    annotationSettings: IAnnotationSettings;
    annotationComments: IAnnotationCommentSummary[];
    annotationCommentsStatus: TAnnotationCommentsStatus;
    annotationActiveCommentStableKey?: string | null | undefined;
    bookmarkEditMode: boolean;
    bookmarkItems: IPdfBookmarkEntry[];
    bookmarksDirty: boolean;
    bookmarkNavigationIntentVersion: number;
    isPageOperationInProgress?: boolean | undefined;
    isDjvuMode?: boolean | undefined;
    selectedThumbnailPages: number[];
    thumbnailInvalidationRequest?: {
        id: number;
        pages: number[];
    } | null | undefined;
    thumbnailHiddenAnnotationIds?: string[] | undefined;
}

const { t } = useTypedI18n();

const {
    activeTab: activeTabProp = undefined,
    annotationActiveCommentStableKey: annotationActiveCommentStableKeyProp = undefined,
    annotationTool,
    annotationKeepActive,
    annotationSettings,
    annotationComments,
    annotationCommentsStatus,
    bookmarkItems,
    bookmarkNavigationIntentVersion,
    bookmarksDirty,
    bookmarkEditMode,
    currentPage,
    currentResultNavigationId,
    currentResultIndex,
    isDjvuMode = false,
    isOpen,
    isResizing = false,
    isPageOperationInProgress = false,
    isSearching,
    isTruncated = undefined,
    minQueryLength = undefined,
    pageLabelRanges = undefined,
    pageLabels = undefined,
    pdfDocument,
    searchError = undefined,
    searchFocusRequest = undefined,
    searchProgress = undefined,
    searchOptions,
    searchQuery,
    searchResults,
    selectedThumbnailPages: selectedThumbnailPagesProp,
    thumbnailHiddenAnnotationIds = undefined,
    submittedSearchQuery = undefined,
    thumbnailInvalidationRequest = undefined,
    totalPages,
    width = undefined,
} = defineProps<IProps>();
const annotationActiveCommentStableKey = computed(() => annotationActiveCommentStableKeyProp ?? null);

const emit = defineEmits<{
    goToPage: [page: number, options?: IScrollToPageOptions];
    goToResult: [index: number];
    'update:activeTab': [value: TPdfSidebarTab];
    'update:searchQuery': [value: string];
    'update:searchOptions': [value: IResolvedSearchMatchOptions];
    'update:annotation-tool': [value: TAnnotationTool];
    'update:annotation-keep-active': [value: boolean];
    'update:bookmark-edit-mode': [value: boolean];
    'update:pageLabelRanges': [ranges: IPdfPageLabelRange[]];
    search: [];
    next: [];
    previous: [];
    'annotation-setting': [payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings]
    }];
    'annotation-focus-comment': [comment: IAnnotationCommentSummary];
    'annotation-open-note': [comment: IAnnotationCommentSummary];
    'annotation-delete-comment': [comment: IAnnotationCommentSummary];
    'annotation-place-note': [];
    'bookmarks-change': [payload: IPdfBookmarkChangePayload];
    'page-context-menu': [payload: {
        clientX: number;
        clientY: number;
        pages: number[]
    }];
    'page-rotate-cw': [pages: number[]];
    'page-rotate-ccw': [pages: number[]];
    'page-extract': [pages: number[]];
    'page-export': [pages: number[]];
    'page-delete': [pages: number[]];
    'page-reorder': [newOrder: number[]];
    'update:selectedThumbnailPages': [pages: number[]];
    'page-file-drop': [payload: {
        afterPage: number;
        filePaths: TDocumentRef[];
    }];
}>();

const searchSession = createPdfDocumentSearchSession({
    query: computed(() => searchQuery),
    submittedQuery: computed(() => submittedSearchQuery ?? ''),
    options: computed(() => searchOptions),
    results: computed(() => searchResults),
    currentResultIndex: computed(() => currentResultIndex),
    currentResultNavigationId: computed(() => currentResultNavigationId),
    isSearching: computed(() => isSearching),
    error: computed(() => searchError ?? null),
    progress: computed(() => searchProgress),
    isTruncated: computed(() => isTruncated ?? false),
    minQueryLength: computed(() => minQueryLength ?? 1),
    setQuery: value => emit('update:searchQuery', value),
    setOptions: value => emit('update:searchOptions', value),
    run: () => emit('search'),
    clear: () => emit('update:searchQuery', ''),
    cancel: () => undefined,
    select: index => emit('goToResult', index),
    navigate: (direction) => {
        if (direction === 'next') {
            emit('next');
        } else {
            emit('previous');
        }
    },
});

const activeTabLocal = ref<TPdfSidebarTab>('thumbnails');

const activeTab = computed<TPdfSidebarTab>({
    get: () => activeTabProp ?? activeTabLocal.value,
    set: (value) => {
        if (activeTabProp !== undefined) {
            emit('update:activeTab', value);
            return;
        }
        activeTabLocal.value = value;
    },
});

const selectedThumbnailPages = computed(() => selectedThumbnailPagesProp);

function handleSelectedPagesUpdate(pages: number[]) {
    emit('update:selectedThumbnailPages', pages);
}

function clearPageSelection() {
    emit('update:selectedThumbnailPages', []);
}

function updateAnnotationTool(tool: TAnnotationTool) {
    emit('update:annotation-tool', tool);
}

function updateAnnotationKeepActive(value: boolean) {
    emit('update:annotation-keep-active', value);
}

function updateAnnotationSetting(payload: {
    key: keyof IAnnotationSettings;
    value: IAnnotationSettings[keyof IAnnotationSettings]
}) {
    emit('annotation-setting', payload);
}

function focusAnnotationComment(comment: IAnnotationCommentSummary) {
    emit('annotation-focus-comment', comment);
}

function openAnnotationNote(comment: IAnnotationCommentSummary) {
    emit('annotation-open-note', comment);
}

function deleteAnnotationComment(comment: IAnnotationCommentSummary) {
    emit('annotation-delete-comment', comment);
}

function placeAnnotationNote() {
    emit('annotation-place-note');
}

function rotateSelectedPagesClockwise() {
    emit('page-rotate-cw', selectedThumbnailPages.value);
}

function rotateSelectedPagesCounterClockwise() {
    emit('page-rotate-ccw', selectedThumbnailPages.value);
}

function extractSelectedPages() {
    emit('page-extract', selectedThumbnailPages.value);
}

function exportSelectedPages() {
    emit('page-export', selectedThumbnailPages.value);
}

function deleteSelectedPages() {
    emit('page-delete', selectedThumbnailPages.value);
}

function goToPage(page: number, options?: IScrollToPageOptions) {
    emit('goToPage', page, options);
}

function openPageContextMenu(payload: {
    clientX: number;
    clientY: number;
    pages: number[];
}) {
    emit('page-context-menu', payload);
}

function reorderPages(newOrder: number[]) {
    emit('page-reorder', newOrder);
}

function dropPageFiles(payload: {
    afterPage: number;
    filePaths: TDocumentRef[];
}) {
    emit('page-file-drop', payload);
}

function updatePageLabelRanges(ranges: IPdfPageLabelRange[]) {
    emit('update:pageLabelRanges', ranges);
}

function updateBookmarks(payload: IPdfBookmarkChangePayload) {
    emit('bookmarks-change', payload);
}

function updateBookmarkEditMode(value: boolean) {
    emit('update:bookmark-edit-mode', value);
}

watch(
    () => [
        isOpen,
        activeTab.value,
    ] as const,
    ([
        _isOpen,
        activeSidebarTab,
    ], [
        wasOpen,
        previousTab,
    ]) => {
        const leftAnnotations = previousTab === 'annotations' && activeSidebarTab !== 'annotations';
        const sidebarClosed = wasOpen && !isOpen;
        if (leftAnnotations || sidebarClosed) {
            emit('update:annotation-tool', 'none');
        }
    },
    { flush: 'post' },
);

watch(
    () => totalPages,
    (totalPages) => {
        if (totalPages <= 0) {
            return;
        }

        const filteredPages = selectedThumbnailPagesProp.filter(page => page <= totalPages);
        if (
            filteredPages.length !== selectedThumbnailPagesProp.length
            || filteredPages.some((page, index) => page !== selectedThumbnailPagesProp[index])
        ) {
            emit('update:selectedThumbnailPages', filteredPages);
        }
    },
);

interface IPdfSidebarTabItem {
    value: TPdfSidebarTab;
    label: string;
    icon: string;
    title: string;
}


const localizedTabs = computed<IPdfSidebarTabItem[]>(() => {
    return resolveDocumentSidebarTabs({
        annotations: !isDjvuMode,
        bookmarks: true,
        pages: true,
        search: true,
    }).map((value) => ({
        value,
        icon: {
            annotations: 'i-ph-chat',
            thumbnails: 'i-ph-file',
            bookmarks: 'i-ph-bookmark',
            search: 'i-ph-magnifying-glass',
        }[value],
        label: t(`sidebar.${value === 'thumbnails' ? 'pages' : value}`),
        title: t(`sidebar.${value === 'thumbnails' ? 'pages' : value}`),
    }));
});
function handleShellTabUpdate(value: string) {
    activeTab.value = value as TPdfSidebarTab;
}

const sidebarStyle = computed(() => {
    const sidebarWidth = width ?? 240;

    return {
        width: `${sidebarWidth}px`,
        maxWidth: '100%',
        minWidth: '0',
    };
});
</script>

<style scoped>
.pdf-sidebar-pages {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
}

.pdf-sidebar-pages-thumbnails {
    flex: 1;
    min-height: var(--app-sidebar-content-min-height);
    overflow: hidden;
}

</style>
