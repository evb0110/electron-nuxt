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
                list: 'p-0 mb-0 rounded-none bg-transparent border-b border-default',
                indicator: 'bg-primary/60 rounded-none bottom-0',
                trigger: 'flex-1 min-w-0 justify-center px-1 py-2 rounded-none text-[11.5px] font-semibold tracking-[0.01em] whitespace-nowrap data-[state=active]:text-default data-[state=inactive]:text-muted data-[state=inactive]:hover:bg-muted/40',
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
        <div class="relative min-h-0 flex-1 overflow-hidden overflow-y-auto [&>*]:w-full app-scrollbar">
            <PdfAnnotationsPanel
                v-show="activeTab === 'annotations'"
                :tool="annotationTool"
                :settings="annotationSettings"
                :comments="annotationComments"
                :active-comment-stable-key="annotationActiveCommentStableKey"
                :current-page="currentPage"
                :keep-active="annotationKeepActive"
                @set-tool="emit('update:annotation-tool', $event)"
                @update:keep-active="emit('update:annotation-keep-active', $event)"
                @update-setting="emit('annotation-setting', $event)"
                @focus-comment="emit('annotation-focus-comment', $event)"
                @open-note="emit('annotation-open-note', $event)"
                @delete-comment="emit('annotation-delete-comment', $event)"
                @place-note="emit('annotation-place-note')"
            />

            <div
                v-show="activeTab === 'thumbnails'"
                class="pdf-sidebar-pages"
            >
                <PdfPageSelectionBar
                    :selected-count="selectedThumbnailPages.length"
                    :is-operation-in-progress="props.isPageOperationInProgress ?? false"
                    @rotate-cw="emit('page-rotate-cw', selectedThumbnailPages)"
                    @rotate-ccw="emit('page-rotate-ccw', selectedThumbnailPages)"
                    @extract-pages="emit('page-extract', selectedThumbnailPages)"
                    @export-pages="emit('page-export', selectedThumbnailPages)"
                    @delete-pages="emit('page-delete', selectedThumbnailPages)"
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
                        @go-to-page="emit('goToPage', $event)"
                        @update:selected-pages="handleSelectedPagesUpdate"
                        @page-context-menu="emit('page-context-menu', $event)"
                        @reorder="emit('page-reorder', $event)"
                        @file-drop="emit('page-file-drop', $event)"
                    />
                </div>

                <PdfSidebarPageNumbering
                    :total-pages="totalPages"
                    :selected-pages="selectedThumbnailPages"
                    :page-labels="pageLabels"
                    :page-label-ranges="pageLabelRanges"
                    @update:selected-pages="handleSelectedPagesUpdate"
                    @update:page-label-ranges="emit('update:pageLabelRanges', $event)"
                    @clear="clearPageSelection"
                />
            </div>

            <PdfOutline
                v-show="activeTab === 'bookmarks'"
                :pdf-document="pdfDocument"
                :current-page="currentPage"
                :is-edit-mode="bookmarkEditMode"
                @go-to-page="$emit('goToPage', $event)"
                @bookmarks-change="emit('bookmarks-change', $event)"
                @update:is-edit-mode="emit('update:bookmark-edit-mode', $event)"
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
                        @search="emit('search')"
                        @next="emit('next')"
                        @previous="emit('previous')"
                    />
                </div>
                <div class="flex min-h-0 flex-col">
                    <PdfSearchResults
                        :results="searchResults"
                        :current-result-index="currentResultIndex"
                        :search-query="submittedSearchQuery ?? ''"
                        :search-options="searchOptions"
                        :page-labels="pageLabels"
                        :is-searching="isSearching"
                        :search-error="props.searchError"
                        :search-progress="props.searchProgress"
                        :is-truncated="props.isTruncated"
                        :min-query-length="props.minQueryLength"
                        @go-to-result="$emit('goToResult', $event)"
                    />
                </div>
            </div>
        </div>
    </aside>
</template>

<script setup lang="ts">

import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TDocumentRef } from '@contracts/platform-api';
import type { IPdfSearchRequestOptions } from '@contracts/search';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
    IPdfSearchMatch,
} from '@app/types/pdf';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import type { TPdfSidebarTab } from '@app/modules/workspace-shell/public';
import PdfAnnotationsPanel from '@app/components/pdf/PdfAnnotationsPanel.vue';
import PdfOutline from '@app/components/pdf/PdfOutline.vue';
import PdfPageSelectionBar from '@app/components/pdf/PdfPageSelectionBar.vue';
import PdfSearchBar from '@app/components/pdf/PdfSearchBar.vue';
import PdfSearchResults from '@app/components/pdf/PdfSearchResults.vue';
import PdfSidebarPageNumbering from '@app/components/pdf/PdfSidebarPageNumbering.vue';
import PdfThumbnails from '@app/components/pdf/PdfThumbnails.vue';

interface IProps {
    isOpen: boolean;
    pdfDocument: PDFDocumentProxy | null;
    currentPage: number;
    totalPages: number;
    pageLabels?: string[] | null;
    pageLabelRanges?: IPdfPageLabelRange[];
    searchResults: IPdfSearchMatch[];
    currentResultIndex: number;
    searchQuery: string;
    submittedSearchQuery?: string;
    searchOptions: Required<Pick<IPdfSearchRequestOptions, 'matchCase' | 'wholeWord' | 'useRegex'>>;
    totalMatches: number;
    isSearching: boolean;
    searchError?: string | null;
    searchFocusRequest?: number;
    searchProgress?: {
        processed: number;
        total: number;
    };
    isTruncated?: boolean;
    minQueryLength?: number;
    activeTab?: TPdfSidebarTab;
    width?: number;
    annotationTool: TAnnotationTool;
    annotationKeepActive: boolean;
    annotationSettings: IAnnotationSettings;
    annotationComments: IAnnotationCommentSummary[];
    annotationActiveCommentStableKey?: string | null;
    bookmarkEditMode: boolean;
    isPageOperationInProgress?: boolean;
    isDjvuMode?: boolean;
    selectedThumbnailPages: number[];
    thumbnailInvalidationRequest?: {
        id: number;
        pages: number[];
    } | null;
}

const { t } = useTypedI18n();

const props = defineProps<IProps>();
const {
    annotationTool,
    annotationKeepActive,
    annotationSettings,
    annotationComments,
} = toRefs(props);
const annotationActiveCommentStableKey = computed(() => props.annotationActiveCommentStableKey ?? null);

const emit = defineEmits<{
    (e: 'goToPage', page: number): void;
    (e: 'goToResult', index: number): void;
    (e: 'update:activeTab', value: TPdfSidebarTab): void;
    (e: 'update:searchQuery', value: string): void;
    (e: 'update:searchOptions', value: Required<Pick<IPdfSearchRequestOptions, 'matchCase' | 'wholeWord' | 'useRegex'>>): void;
    (e: 'update:annotation-tool', value: TAnnotationTool): void;
    (e: 'update:annotation-keep-active', value: boolean): void;
    (e: 'update:bookmark-edit-mode', value: boolean): void;
    (e: 'update:pageLabelRanges', ranges: IPdfPageLabelRange[]): void;
    (e: 'search'): void;
    (e: 'next'): void;
    (e: 'previous'): void;
    (e: 'annotation-setting', payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings]
    }): void;
    (e: 'annotation-focus-comment', comment: IAnnotationCommentSummary): void;
    (e: 'annotation-open-note', comment: IAnnotationCommentSummary): void;
    (e: 'annotation-delete-comment', comment: IAnnotationCommentSummary): void;
    (e: 'annotation-place-note'): void;
    (e: 'bookmarks-change', payload: {
        bookmarks: IPdfBookmarkEntry[];
        dirty: boolean;
    }): void;
    (e: 'page-context-menu', payload: {
        clientX: number;
        clientY: number;
        pages: number[]
    }): void;
    (e: 'page-rotate-cw', pages: number[]): void;
    (e: 'page-rotate-ccw', pages: number[]): void;
    (e: 'page-extract', pages: number[]): void;
    (e: 'page-export', pages: number[]): void;
    (e: 'page-delete', pages: number[]): void;
    (e: 'page-reorder', newOrder: number[]): void;
    (e: 'update:selectedThumbnailPages', pages: number[]): void;
    (e: 'page-file-drop', payload: {
        afterPage: number;
        filePaths: TDocumentRef[];
    }): void;
}>();

const activeTabLocal = ref<TPdfSidebarTab>('thumbnails');

const activeTab = computed<TPdfSidebarTab>({
    get: () => props.activeTab ?? activeTabLocal.value,
    set: (value) => {
        if (props.activeTab !== undefined) {
            emit('update:activeTab', value);
            return;
        }
        activeTabLocal.value = value;
    },
});

const searchQueryProxy = computed({
    get: () => props.searchQuery,
    set: (value: string) => emit('update:searchQuery', value),
});

const searchBarRef = ref<{ focus: () => void } | null>(null);
const selectedThumbnailPages = computed(() => props.selectedThumbnailPages);

async function focusSearch() {
    await nextTick();
    searchBarRef.value?.focus();
}

function handleSelectedPagesUpdate(pages: number[]) {
    emit('update:selectedThumbnailPages', pages);
}

function handleSearchOptionsUpdate(value: Required<Pick<IPdfSearchRequestOptions, 'matchCase' | 'wholeWord' | 'useRegex'>>) {
    emit('update:searchOptions', value);
}

function clearPageSelection() {
    emit('update:selectedThumbnailPages', []);
}

watch(
    () => [
        props.isOpen,
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
    () => props.searchFocusRequest,
    async () => {
        if (props.isOpen && activeTab.value === 'search') {
            await focusSearch();
        }
    },
    { flush: 'post' },
);

watch(
    () => props.totalPages,
    (totalPages) => {
        if (totalPages <= 0) {
            return;
        }

        const filteredPages = props.selectedThumbnailPages.filter(page => page <= totalPages);
        if (
            filteredPages.length !== props.selectedThumbnailPages.length
            || filteredPages.some((page, index) => page !== props.selectedThumbnailPages[index])
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

const COMPACT_THRESHOLD = 280;
const isCompact = computed(() => (props.width ?? 240) < COMPACT_THRESHOLD);

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
    const items = props.isDjvuMode
        ? allTabs.filter((tab) => tab.value !== 'annotations')
        : allTabs;

    return items.map((tab) => ({
        ...tab,
        label: isCompact.value ? '' : t(`sidebar.${tab.value === 'annotations' ? 'notes' : tab.value === 'thumbnails' ? 'pages' : tab.value}`),
        title: t(`sidebar.${tab.value === 'annotations' ? 'notes' : tab.value === 'thumbnails' ? 'pages' : tab.value}`),
    }));
});

const sidebarStyle = computed(() => {
    const width = props.width ?? 240;

    return {
        width: `${width}px`,
        minWidth: `${width}px`,
    };
});
</script>

<style scoped>
.pdf-sidebar {
    display: flex;
    height: 100%;
    flex-direction: column;
    overflow: hidden;
    background: color-mix(in oklab, var(--ui-bg) 92%, var(--ui-bg-muted) 8%);
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
    overflow: hidden auto;
}
</style>
