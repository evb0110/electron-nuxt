<template>
    <AppSidebarShell
        class="document-source-sidebar"
        data-testid="document-sidebar"
        :aria-label="t('documentSourceSidebar.navLabel')"
        :model-value="activeTab"
        :tabs="availableShellTabs"
        :outer-scroll="activeTab === 'annotations'"
        @update:model-value="handleShellTabUpdate"
    >
        <div v-show="activeTab === 'annotations'" class="document-source-sidebar__content">
            <button type="button" class="document-source-sidebar__add" @click="addNote">
                {{ t('documentSourceSidebar.addNoteOnPage', {page: currentPage}) }}
            </button>
            <DocumentPanelEmptyState
                v-if="pageAnnotations.length === 0"
                icon="i-ph-chat"
                :title="t('documentSourceSidebar.noAnnotations')"
            />
            <div v-for="annotation in pageAnnotations" :key="annotation.id" class="document-source-sidebar__annotation">
                <span>{{ String(annotation.payload.label ?? t('documentSourceSidebar.note')) }}</span>
                <button type="button" :aria-label="t('documentSourceSidebar.deleteAnnotation', {id: annotation.id})" @click="removeAnnotation(annotation.id)">×</button>
            </div>
        </div>

        <DocumentThumbnailList
            v-if="source?.thumbnailProvider"
            v-show="activeTab === 'thumbnails'"
            :source="source"
            :current-page="currentPage"
            :is-resizing="isResizing"
            @go-to-page="emit('go-to-page', $event)"
        />

        <div v-show="activeTab === 'bookmarks'" class="document-source-sidebar__content app-panel-scroll app-scrollbar">
            <p v-if="outlineLoading" class="document-source-sidebar__status">{{ t('documentSourceSidebar.loadingOutline') }}</p>
            <DocumentPanelEmptyState
                v-else-if="outlineError"
                icon="i-ph-warning"
                :title="t('searchResults.unavailable')"
                :description="outlineError"
            />
            <DocumentPanelEmptyState
                v-else-if="outlineItems.length === 0"
                icon="i-ph-bookmark"
                :title="t('documentSourceSidebar.noOutline')"
            />
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

        <DocumentSearchPanel
            v-show="activeTab === 'search'"
            :session="searchSession"
            :is-active="activeTab === 'search'"
            :focus-request="searchFocusRequest ?? 0"
        />
    </AppSidebarShell>
</template>

<script setup lang="ts">
import type { IDocumentPageSource } from '@app/utils/document-viewer/source/documentPageSource';
import {
    flattenDocumentOutline,
    type IDocumentFlatOutlineItem,
} from '@app/utils/document-viewer/providers/flattenDocumentOutline';
import type { IDocumentSearchSession } from '@app/utils/document-viewer/search/documentSearch';
import {
    reconcileDocumentSidebarTab,
    resolveDocumentSidebarTabs,
    type TDocumentSidebarTab,
} from '@app/utils/document-viewer/sidebar/documentSidebarTabs';
import AppSidebarShell from '@app/components/sidebar/AppSidebarShell.vue';
import DocumentPanelEmptyState from '@app/components/document-viewer/DocumentPanelEmptyState.vue';
import DocumentSearchPanel from '@app/components/document-viewer/DocumentSearchPanel.vue';
import DocumentThumbnailList from '@app/components/document-viewer/DocumentThumbnailList.vue';

const { t } = useTypedI18n();
const props = defineProps<{
    source: IDocumentPageSource | null;
    currentPage: number;
    annotationRevision: number;
    searchSession: IDocumentSearchSession;
    isResizing?: boolean;
    searchFocusRequest?: number;
}>();
const emit = defineEmits<{
    'go-to-page': [pageNumber: number];
    'annotations-changed': [];
}>();

const activeTab = defineModel<TDocumentSidebarTab>('activeTab', {required: true});
const outlineItems = ref<IDocumentFlatOutlineItem[]>([]);
const outlineLoading = ref(false);
const outlineError = ref<string | null>(null);
let outlineController: AbortController | null = null;
let sourceGeneration = 0;

const availableTabs = computed(() => resolveDocumentSidebarTabs({
    annotations: Boolean(props.source?.annotationProvider),
    bookmarks: Boolean(props.source?.outlineProvider),
    pages: Boolean(props.source?.thumbnailProvider),
    search: Boolean(props.source?.searchProvider ?? props.source?.textProvider),
}));
const availableShellTabs = computed(() => availableTabs.value.map(tab => ({
    value: tab,
    label: getTabLabel(tab),
    title: getTabLabel(tab),
    icon: {
        annotations: 'i-ph-chat',
        thumbnails: 'i-ph-file',
        bookmarks: 'i-ph-bookmark',
        search: 'i-ph-magnifying-glass',
    }[tab],
})));
const pageAnnotations = computed(() => {
    void props.annotationRevision;
    return props.source?.annotationProvider?.getPageAnnotations(props.currentPage) ?? [];
});

function getTabLabel(tab: TDocumentSidebarTab) {
    return t(`sidebar.${tab === 'thumbnails' ? 'pages' : tab}`);
}

function handleShellTabUpdate(value: string) {
    if (!availableTabs.value.includes(value as TDocumentSidebarTab)) {
        return;
    }
    activeTab.value = value as TDocumentSidebarTab;
}

function cancelOutline() {
    outlineController?.abort();
    outlineController = null;
    outlineLoading.value = false;
}

async function loadOutline() {
    const source = props.source;
    const provider = source?.outlineProvider;
    if (!source || !provider || activeTab.value !== 'bookmarks') {
        return;
    }
    cancelOutline();
    const controller = new AbortController();
    const generation = sourceGeneration;
    outlineController = controller;
    outlineLoading.value = true;
    outlineError.value = null;
    try {
        const items = flattenDocumentOutline(await provider.getOutline(controller.signal));
        if (props.source === source && generation === sourceGeneration) outlineItems.value = items;
    } catch (error) {
        if (!controller.signal.aborted) outlineError.value = error instanceof Error ? error.message : String(error);
    } finally {
        if (outlineController === controller) {
            outlineController = null;
            outlineLoading.value = false;
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
    if (props.source?.annotationProvider?.remove(annotationId)) emit('annotations-changed');
}

watch(() => props.source, () => {
    sourceGeneration += 1;
    cancelOutline();
    outlineItems.value = [];
    outlineError.value = null;
    const reconciled = reconcileDocumentSidebarTab(activeTab.value, availableTabs.value);
    if (reconciled) activeTab.value = reconciled;
    if (activeTab.value === 'bookmarks') void nextTick(loadOutline);
}, {flush: 'post'});
watch(availableTabs, (tabs) => {
    const reconciled = reconcileDocumentSidebarTab(activeTab.value, tabs);
    if (reconciled) activeTab.value = reconciled;
}, {immediate: true});
watch(activeTab, (tab) => {
    if (tab === 'bookmarks') void loadOutline();
    else cancelOutline();
});
onBeforeUnmount(cancelOutline);
</script>

<style scoped>
.document-source-sidebar {
    width: 100%;
    height: 100%;
    min-width: 0;
}

.document-source-sidebar__content {
    display: flex;
    flex-direction: column;
    gap: var(--app-sidebar-row-gap);
    min-height: 0;
    padding: var(--app-sidebar-content-padding);
}

.document-source-sidebar__row {
    padding: var(--app-sidebar-row-padding-block) var(--app-sidebar-row-padding-inline);
    text-align: left;
    border-radius: var(--app-radius-md);
}

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
