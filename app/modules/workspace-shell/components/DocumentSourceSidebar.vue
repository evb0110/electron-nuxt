<template>
    <AppSidebarShell
        class="document-source-sidebar"
        data-testid="document-source-sidebar"
        :aria-label="t('documentSourceSidebar.navLabel')"
        :model-value="activeTab"
        :tabs="availableShellTabs"
        :outer-scroll="false"
        @update:model-value="handleShellTabUpdate"
    >
        <div v-if="activeTab === 'thumbnails'" class="document-source-sidebar__content app-panel-scroll app-scrollbar">
            <button
                v-for="page in thumbnailPages"
                :key="page"
                type="button"
                class="document-source-sidebar__thumbnail"
                :class="{'is-current': page === currentPage}"
                :aria-label="t('documentSourceSidebar.goToPage', {page})"
                @click="emit('go-to-page', page)"
            >
                <img v-if="thumbnailUrls.get(page)" :src="thumbnailUrls.get(page)" alt="">
                <span v-else class="document-source-sidebar__thumbnail-placeholder" />
                <span>{{ page }}</span>
            </button>
        </div>

        <div v-else-if="activeTab === 'outline'" class="document-source-sidebar__content app-panel-scroll app-scrollbar">
            <p v-if="outlineLoading" class="document-source-sidebar__status">{{ t('documentSourceSidebar.loadingOutline') }}</p>
            <p v-else-if="outlineItems.length === 0" class="document-source-sidebar__status">{{ t('documentSourceSidebar.noOutline') }}</p>
            <button
                v-for="item in outlineItems"
                :key="`${item.depth}:${item.title}:${item.pageNumber}`"
                type="button"
                class="document-source-sidebar__row"
                :style="{paddingInlineStart: `calc(var(--app-sidebar-row-padding-inline) + ${item.depth} * var(--app-sidebar-outline-depth-indent))`}"
                :disabled="item.pageNumber === null"
                @click="item.pageNumber && emit('go-to-page', item.pageNumber)"
            >{{ item.title }}</button>
        </div>

        <div v-else-if="activeTab === 'search'" class="document-source-sidebar__search app-panel-scroll app-scrollbar">
            <form @submit.prevent="runSearch">
                <input v-model="searchQuery" type="search" :placeholder="t('documentSourceSidebar.searchPlaceholder')" :aria-label="t('documentSourceSidebar.searchPlaceholder')">
                <button type="submit" :disabled="searching || searchQuery.trim().length < 2">{{ t('documentSourceSidebar.searchAction') }}</button>
            </form>
            <p v-if="searching" class="document-source-sidebar__status">{{ t('documentSourceSidebar.searching') }}</p>
            <p v-else-if="searchComplete && searchResults.length === 0" class="document-source-sidebar__status">{{ t('documentSourceSidebar.noResults') }}</p>
            <button
                v-for="result in searchResults"
                :key="`${result.pageNumber}:${result.excerpt}`"
                type="button"
                class="document-source-sidebar__search-result"
                @click="emit('go-to-page', result.pageNumber)"
            >
                <strong>{{ t('documentSourceSidebar.page', {page: result.pageNumber}) }}</strong>
                <span>{{ result.excerpt }}</span>
            </button>
        </div>

        <div v-else class="document-source-sidebar__content app-panel-scroll app-scrollbar">
            <button type="button" class="document-source-sidebar__add" @click="addNote">{{ t('documentSourceSidebar.addNoteOnPage', {page: currentPage}) }}</button>
            <p v-if="pageAnnotations.length === 0" class="document-source-sidebar__status">{{ t('documentSourceSidebar.noAnnotations') }}</p>
            <div v-for="annotation in pageAnnotations" :key="annotation.id" class="document-source-sidebar__annotation">
                <span>{{ String(annotation.payload.label ?? t('documentSourceSidebar.note')) }}</span>
                <button type="button" :aria-label="t('documentSourceSidebar.deleteAnnotation', {id: annotation.id})" @click="removeAnnotation(annotation.id)">×</button>
            </div>
        </div>
    </AppSidebarShell>
</template>

<script setup lang="ts">
import type {
    IDocumentPageSource,
    IDocumentSurfaceLease,
} from '@app/utils/document-viewer/source/documentPageSource';
import {
    flattenDocumentOutline,
    searchDocumentText,
    type IDocumentFlatOutlineItem,
    type IDocumentTextSearchResult,
} from '@app/utils/document-viewer/providers/documentSourceNavigation';
import AppSidebarShell from '@app/components/sidebar/AppSidebarShell.vue';

type TSourceSidebarTab = 'thumbnails' | 'outline' | 'search' | 'annotations';

const { t } = useTypedI18n();

const props = defineProps<{
    source: IDocumentPageSource | null;
    currentPage: number;
    annotationRevision: number;
}>();
const emit = defineEmits<{
    'go-to-page': [pageNumber: number];
    'annotations-changed': [];
}>();

const activeTab = ref<TSourceSidebarTab>('thumbnails');
const thumbnailLeases = new Map<number, IDocumentSurfaceLease>();
const thumbnailUrls = shallowReactive(new Map<number, string>());
const outlineItems = ref<IDocumentFlatOutlineItem[]>([]);
const outlineLoading = ref(false);
const searchQuery = ref('');
const searchResults = ref<IDocumentTextSearchResult[]>([]);
const searching = ref(false);
const searchComplete = ref(false);
let operationController: AbortController | null = null;

const availableTabs = computed<TSourceSidebarTab[]>(() => [
    'thumbnails',
    ...(props.source?.outlineProvider ? ['outline' as const] : []),
    ...(props.source?.textProvider ? ['search' as const] : []),
    ...(props.source?.annotationProvider ? ['annotations' as const] : []),
]);
const availableShellTabs = computed(() => availableTabs.value.map(tab => ({
    value: tab,
    label: getTabLabel(tab),
    title: getTabLabel(tab),
    icon: {
        thumbnails: 'i-ph-file',
        outline: 'i-ph-bookmark',
        search: 'i-ph-magnifying-glass',
        annotations: 'i-ph-chat',
    }[tab],
})));
const thumbnailPages = computed(() => {
    const count = props.source?.pageCount ?? 0;
    const start = Math.max(1, props.currentPage - 12);
    const end = Math.min(count, props.currentPage + 12);
    return Array.from({length: Math.max(0, end - start + 1)}, (_, index) => start + index);
});
const pageAnnotations = computed(() => {
    void props.annotationRevision;
    return props.source?.annotationProvider?.getPageAnnotations(props.currentPage) ?? [];
});

function getTabLabel(tab: TSourceSidebarTab) {
    const labels = {
        thumbnails: t('sidebar.pages'),
        outline: t('sidebar.bookmarks'),
        search: t('sidebar.search'),
        annotations: t('sidebar.annotations'),
    } satisfies Record<TSourceSidebarTab, string>;
    return labels[tab];
}

function handleShellTabUpdate(value: string) {
    if (availableTabs.value.includes(value as TSourceSidebarTab)) {
        activeTab.value = value as TSourceSidebarTab;
    }
}

function releaseThumbnails() {
    thumbnailLeases.forEach(lease => lease.release());
    thumbnailLeases.clear();
    thumbnailUrls.clear();
}
async function loadThumbnails() {
    const source = props.source;
    const provider = source?.thumbnailProvider;
    if (!source || !provider || activeTab.value !== 'thumbnails') {
        return;
    }
    const retained = new Set(thumbnailPages.value);
    for (const [
        page,
        lease,
    ] of thumbnailLeases) {
        if (!retained.has(page)) {
            lease.release();
            thumbnailLeases.delete(page);
            thumbnailUrls.delete(page);
        }
    }
    await Promise.all(thumbnailPages.value.map(async (pageNumber) => {
        if (thumbnailLeases.has(pageNumber)) {
            return;
        }
        const controller = new AbortController();
        try {
            const lease = await provider.renderThumbnail({
                pageNumber,
                widthPx: 132,
                priority: 'thumbnail',
                signal: controller.signal,
            });
            if (props.source !== source || activeTab.value !== 'thumbnails') {
                lease.release();
                return;
            }
            thumbnailLeases.set(pageNumber, lease);
            if (typeof lease.surface === 'string') {
                thumbnailUrls.set(pageNumber, lease.surface);
            }
        } catch {
            // A failed thumbnail must not disable document navigation.
        }
    }));
}
async function loadOutline() {
    const provider = props.source?.outlineProvider;
    if (!provider || activeTab.value !== 'outline') {
        return;
    }
    operationController?.abort();
    const controller = new AbortController();
    operationController = controller;
    outlineLoading.value = true;
    try {
        outlineItems.value = flattenDocumentOutline(await provider.getOutline(controller.signal));
    } catch {
        outlineItems.value = [];
    } finally {
        if (operationController === controller) {
            outlineLoading.value = false;
        }
    }
}
async function runSearch() {
    const source = props.source;
    const provider = source?.textProvider;
    const query = searchQuery.value.trim().toLocaleLowerCase();
    if (!source || !provider || query.length < 2) {
        return;
    }
    operationController?.abort();
    const controller = new AbortController();
    operationController = controller;
    searching.value = true;
    searchComplete.value = false;
    searchResults.value = [];
    try {
        searchResults.value = await searchDocumentText(source, query, controller.signal);
        searchComplete.value = true;
    } catch {
        searchComplete.value = false;
    } finally {
        if (operationController === controller) {
            searching.value = false;
        }
    }
}
function addNote() {
    props.source?.annotationProvider?.upsert({
        id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        pageNumber: props.currentPage,
        payload: {
            kind: 'note',
            label: t('documentSourceSidebar.note'),
            x: 0.08,
            y: 0.08,
            width: 0.18,
            height: 0.08,
            color: '#f59e0b',
        },
    });
    emit('annotations-changed');
}
function removeAnnotation(annotationId: string) {
    if (props.source?.annotationProvider?.remove(annotationId)) {
        emit('annotations-changed');
    }
}

watch(() => props.source, () => {
    releaseThumbnails();
    outlineItems.value = [];
    searchResults.value = [];
    searchComplete.value = false;
});
watch([
    () => props.source,
    activeTab,
    thumbnailPages,
], () => {
    if (!availableTabs.value.includes(activeTab.value)) activeTab.value = 'thumbnails';
    if (activeTab.value === 'thumbnails') void loadThumbnails();
    if (activeTab.value === 'outline') void loadOutline();
}, {immediate: true});
onBeforeUnmount(() => {
    operationController?.abort();
    releaseThumbnails();
});
</script>

<style scoped>
.document-source-sidebar {
    width: min(100%, var(--app-document-source-sidebar-width));
    min-width: 0;
}

.document-source-sidebar__content,
.document-source-sidebar__search {
    display: flex;
    flex-direction: column;
    gap: var(--app-sidebar-row-gap);
    min-height: 0;
    padding: var(--app-sidebar-content-padding);
}

.document-source-sidebar__thumbnail {
    display: grid;
    gap: var(--app-space-xs);
    justify-items: center;
    padding: var(--app-sidebar-row-padding-block);
    border: 1px solid transparent;
    border-radius: var(--app-radius-md);
}

.document-source-sidebar__thumbnail.is-current { border-color: var(--ui-primary); }

.document-source-sidebar__thumbnail img,
.document-source-sidebar__thumbnail-placeholder {
    width: var(--app-document-source-thumbnail-width);
    min-height: var(--app-document-source-thumbnail-min-height);
    object-fit: contain;
    background: var(--ui-bg-elevated);
}

.document-source-sidebar__row,
.document-source-sidebar__search-result {
    padding: var(--app-sidebar-row-padding-block) var(--app-sidebar-row-padding-inline);
    text-align: left;
    border-radius: var(--app-radius-md);
}

.document-source-sidebar__search form {
    display: flex;
    gap: var(--app-space-xs);
}

.document-source-sidebar__search input {
    flex: 1;
    min-width: 0;
    padding: var(--app-sidebar-row-padding-block);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-md);
}

.document-source-sidebar__search-result {
    display: flex;
    flex-direction: column;
    gap: var(--app-space-2xs);
}

.document-source-sidebar__search-result span,
.document-source-sidebar__status {
    color: var(--ui-text-muted);
    font-size: var(--app-sidebar-caption-font-size);
}

.document-source-sidebar__add {
    padding: var(--app-sidebar-row-padding-block) var(--app-sidebar-row-padding-inline);
    background: var(--ui-bg-elevated);
    border-radius: var(--app-radius-md);
}

.document-source-sidebar__annotation {
    display: flex;
    justify-content: space-between;
    padding: var(--app-sidebar-row-padding-block) var(--app-sidebar-row-padding-inline);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-md);
}
</style>
