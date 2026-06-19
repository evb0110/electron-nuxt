<template>
    <aside
        v-show="isOpen"
        class="pdf-sidebar"
        :style="sidebarStyle"
    >
        <UTabs
            v-model="activeTab"
            :items="tabs"
            :content="false"
            variant="link"
            color="primary"
            size="sm"
            :ui="{
                root: 'gap-0',
                list: 'gap-1 px-2 py-1.5 mb-0 rounded-none bg-transparent border-b border-[var(--app-sidebar-border)]',
                indicator: 'hidden',
                trigger: 'flex-1 min-w-0 justify-center gap-1.5 h-7 px-1.5 py-0 rounded-md border border-transparent text-[11.5px] font-semibold tracking-[0.01em] whitespace-nowrap data-[state=active]:bg-[var(--app-control-active-bg)] data-[state=active]:border-[var(--app-control-active-border)] data-[state=active]:text-default data-[state=inactive]:text-muted data-[state=inactive]:hover:bg-[var(--app-sidebar-control-hover-bg)] data-[state=inactive]:hover:text-default',
                leadingIcon: 'size-3.5 shrink-0',
            }"
            class="shrink-0"
        >
            <template #leading="{ item }">
                <AppTooltip
                    v-if="isCompact"
                    :text="item.title"
                    :delay-duration="300"
                >
                    <UIcon
                        :name="item.icon"
                        class="size-3.5 shrink-0"
                    />
                </AppTooltip>
                <UIcon
                    v-else
                    :name="item.icon"
                    class="size-3.5 shrink-0"
                />
            </template>
        </UTabs>
        <div
            class="pdf-sidebar-content relative min-h-0 flex-1 overflow-hidden overflow-y-auto [&>*]:w-full app-scrollbar"
            :class="{ 'pdf-sidebar-content-bookmarks': activeTab === 'bookmarks' }"
        >
            <PdfAnnotationsPanel
                v-show="activeTab === 'annotations'"
                :tool="annotationTool"
                :settings="annotationSettings"
                :comments="annotationComments"
                :comments-status="annotationCommentsStatus"
                :active-comment-stable-key="annotationActiveCommentStableKey"
                :current-page="currentPage"
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
                    @rotate-cw="rotateSelectedPagesClockwise"
                    @rotate-ccw="rotateSelectedPagesCounterClockwise"
                    @extract-pages="extractSelectedPages"
                    @export-pages="exportSelectedPages"
                    @delete-pages="deleteSelectedPages"
                    @deselect="clearPageSelection"
                />
                <div class="pdf-sidebar-pages-thumbnails app-scrollbar">
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
                        :page-preview-provider="thumbnailPagePreviewProvider"
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
                @go-to-page="goToPage"
                @bookmarks-change="updateBookmarks"
                @update:is-edit-mode="updateBookmarkEditMode"
            />
            <div
                v-show="activeTab === 'search'"
                class="flex h-full min-h-0 flex-col"
            >
                <div class="sticky top-0 z-[1] border-b border-[var(--ui-border)] bg-inherit">
                    <PdfSearchBar
                        ref="searchBarRef"
                        v-model="searchQueryProxy"
                        :options="searchOptions"
                        :total-matches="totalMatches"
                        @update:options="handleSearchOptionsUpdate"
                        @search="search"
                        @next="nextSearchResult"
                        @previous="previousSearchResult"
                    />
                </div>
                <div class="flex min-h-0 flex-col">
                    <PdfSearchResults
                        :results="searchResults"
                        :current-result-index="currentResultIndex"
                        :current-result-navigation-id="currentResultNavigationId"
                        :search-query="submittedSearchQuery ?? ''"
                        :search-options="searchOptions"
                        :page-labels="pageLabels"
                        :is-searching="isSearching"
                        :search-error="searchError"
                        :search-progress="searchProgress"
                        :is-truncated="isTruncated"
                        :min-query-length="minQueryLength"
                        @go-to-result="goToResult"
                    />
                </div>
            </div>
        </div>
    </aside>
</template>

<script setup lang="ts">

import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IResolvedSearchMatchOptions } from '@contracts/search';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
    IPdfSearchMatch,
} from '@app/types/pdf';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    TAnnotationCommentsStatus,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IPdfPagePreviewEntry } from '@app/modules/pdf-viewer/engine/pdf-page-preview/pdfPagePreviewTypes';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type { TPdfSidebarTab } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types';
import PdfAnnotationsPanel from '@app/modules/pdf-viewer/components/PdfAnnotationsPanel.vue';
import PdfOutline from '@app/modules/pdf-viewer/components/PdfOutline.vue';
import PdfPageSelectionBar from '@app/modules/pdf-viewer/components/PdfPageSelectionBar.vue';
import PdfSearchBar from '@app/modules/pdf-viewer/components/PdfSearchBar.vue';
import PdfSearchResults from '@app/modules/pdf-viewer/components/PdfSearchResults.vue';
import PdfSidebarPageNumbering from '@app/modules/pdf-viewer/components/PdfSidebarPageNumbering.vue';
import PdfThumbnails from '@app/modules/pdf-viewer/components/PdfThumbnails.vue';

interface IProps {
    isOpen: boolean;
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
    totalMatches: number;
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
    isPageOperationInProgress?: boolean | undefined;
    isDjvuMode?: boolean | undefined;
    selectedThumbnailPages: number[];
    thumbnailInvalidationRequest?: {
        id: number;
        pages: number[];
    } | null | undefined;
    thumbnailHiddenAnnotationIds?: string[] | undefined;
    thumbnailPagePreviewProvider?: ((page: number) => IPdfPagePreviewEntry | null) | null | undefined;
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
    bookmarkEditMode,
    currentPage,
    currentResultNavigationId,
    currentResultIndex,
    isDjvuMode = false,
    isOpen,
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
    thumbnailPagePreviewProvider = null,
    submittedSearchQuery = undefined,
    thumbnailInvalidationRequest = undefined,
    totalMatches,
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
    'bookmarks-change': [payload: {
        bookmarks: IPdfBookmarkEntry[];
        dirty: boolean;
    }];
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

const searchQueryProxy = computed({
    get: () => searchQuery,
    set: (value: string) => emit('update:searchQuery', value),
});

const searchBarRef = ref<{ focus: () => void } | null>(null);
const selectedThumbnailPages = computed(() => selectedThumbnailPagesProp);

async function focusSearch() {
    await nextTick();
    searchBarRef.value?.focus();
}

function handleSelectedPagesUpdate(pages: number[]) {
    emit('update:selectedThumbnailPages', pages);
}

function handleSearchOptionsUpdate(value: IResolvedSearchMatchOptions) {
    emit('update:searchOptions', value);
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

function updateBookmarks(payload: {
    bookmarks: IPdfBookmarkEntry[];
    dirty: boolean;
}) {
    emit('bookmarks-change', payload);
}

function updateBookmarkEditMode(value: boolean) {
    emit('update:bookmark-edit-mode', value);
}

function search() {
    emit('search');
}

function nextSearchResult() {
    emit('next');
}

function previousSearchResult() {
    emit('previous');
}

function goToResult(index: number) {
    emit('goToResult', index);
}

watch(
    () => [
        isOpen,
        activeTab.value,
    ] as const,
    async ([
        isOpen,
        activeSidebarTab,
    ], [
        wasOpen,
        previousTab,
    ]) => {
        if (isOpen && activeSidebarTab === 'search') {
            await focusSearch();
        }

        const leftAnnotations = previousTab === 'annotations' && activeSidebarTab !== 'annotations';
        const sidebarClosed = wasOpen && !isOpen;
        if (leftAnnotations || sidebarClosed) {
            emit('update:annotation-tool', 'none');
        }
    },
    { flush: 'post' },
);

watch(
    () => searchFocusRequest,
    async () => {
        if (isOpen && activeTab.value === 'search') {
            await focusSearch();
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

const COMPACT_THRESHOLD = 340;
const isCompact = computed(() => (width ?? 240) < COMPACT_THRESHOLD);

const allTabs: IPdfSidebarTabItem[] = [
    {
        value: 'annotations',
        label: '',
        icon: 'i-ph-chat',
        title: '',
    },
    {
        value: 'thumbnails',
        label: '',
        icon: 'i-ph-file',
        title: '',
    },
    {
        value: 'bookmarks',
        label: '',
        icon: 'i-ph-bookmark',
        title: '',
    },
    {
        value: 'search',
        label: '',
        icon: 'i-ph-magnifying-glass',
        title: '',
    },
];

const tabs = computed<IPdfSidebarTabItem[]>(() => {
    const items = isDjvuMode
        ? allTabs.filter((tab) => tab.value !== 'annotations')
        : allTabs;

    return items.map((tab) => ({
        ...tab,
        label: isCompact.value ? '' : t(`sidebar.${tab.value === 'thumbnails' ? 'pages' : tab.value}`),
        title: t(`sidebar.${tab.value === 'thumbnails' ? 'pages' : tab.value}`),
    }));
});

const sidebarStyle = computed(() => {
    const sidebarWidth = width ?? 240;

    return {
        width: `${sidebarWidth}px`,
        minWidth: `${sidebarWidth}px`,
    };
});
</script>

<style scoped>
.pdf-sidebar {
    display: flex;
    height: 100%;
    flex-direction: column;
    overflow: hidden;
    background: var(--app-sidebar-bg);
}

.pdf-sidebar-pages {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
}

.pdf-sidebar-pages-thumbnails {
    flex: 1;
    min-height: 80px;
    overflow: hidden;
}

.pdf-sidebar-content-bookmarks {
    overflow-y: hidden;
}
</style>
