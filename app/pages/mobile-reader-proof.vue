<template>
    <main class="flex h-dvh min-h-0 flex-col bg-[var(--ui-bg)] text-[var(--ui-text)]">
        <PdfToolbar
            :has-pdf="Boolean(pdfSrc)"
            :can-save="false"
            :can-undo="false"
            :can-redo="false"
            :can-export-docx="false"
            :is-saving="false"
            :is-saving-as="false"
            :is-any-saving="false"
            :is-history-busy="false"
            :is-exporting-docx="false"
            :is-opening-document="isOpening"
            :is-preparing-print="false"
            :is-fit-width-active="zoomMode === 'fit-width'"
            :is-fit-height-active="zoomMode === 'fit-height'"
            :show-sidebar="false"
            :can-toggle-sidebar="false"
            :drag-mode="dragMode"
            :continuous-scroll="continuousScroll"
            :is-djvu-mode="false"
            :surface="toolbarSurface"
            variant="reader"
            :is-capturing-region="false"
            :is-crop-selecting="false"
            :is-placing-page-note="false"
            @open-file="handleOpen"
            @open-settings="showSettings = true"
            @fit-width="handleFitWidth"
            @fit-height="handleFitHeight"
            @toggle-continuous-scroll="continuousScroll = !continuousScroll"
            @enable-drag="dragMode = true"
            @disable-drag="dragMode = false"
        >
            <template v-if="pdfSrc" #app-menu>
                <ToolbarButton
                    icon="lucide:x"
                    :tooltip="t('annotationProperties.close', undefined)"
                    @click="handleClose"
                />
            </template>
            <template #overflow-menu="{ collapseTier }">
                <ToolbarButton
                    v-if="pdfSrc"
                    icon="lucide:search"
                    :active="isSearchOpen"
                    :tooltip="t('sidebar.search', undefined)"
                    @click="isSearchOpen = !isSearchOpen"
                />
                <ToolbarOverflowMenu
                    :open="overflowMenuOpen"
                    :collapse-tier="Math.max(collapseTier, 3)"
                    :can-toggle-sidebar="false"
                    :can-capture-region="false"
                    :can-crop="false"
                    :can-quick-note="false"
                    :has-pdf="Boolean(pdfSrc)"
                    :can-use-ocr="false"
                    :show-sidebar="false"
                    :drag-mode="dragMode"
                    :continuous-scroll="continuousScroll"
                    :view-mode="viewMode"
                    :is-djvu-mode="false"
                    :is-fit-width-active="zoomMode === 'fit-width'"
                    :is-fit-height-active="zoomMode === 'fit-height'"
                    :is-capturing-region="false"
                    :is-crop-selecting="false"
                    :is-placing-page-note="false"
                    :surface="toolbarSurface"
                    trigger-icon="i-lucide-menu"
                    @update:open="overflowMenuOpen = $event"
                    @capture-region="noopToolbarAction"
                    @crop="noopToolbarAction"
                    @toggle-sidebar="noopToolbarAction"
                    @fit-width="handleFitWidth"
                    @fit-height="handleFitHeight"
                    @enable-drag="dragMode = true"
                    @disable-drag="dragMode = false"
                    @set-view-mode="viewMode = $event"
                    @toggle-continuous-scroll="continuousScroll = !continuousScroll"
                    @quick-note="noopToolbarAction"
                    @open-settings="showSettings = true"
                />
            </template>
            <template v-if="pdfSrc" #page-dropdown>
                <PdfPageDropdown
                    v-model="currentPage"
                    :open="pageDropdownOpen"
                    :total-pages="totalPages"
                    :view-mode="viewMode"
                    :disabled="!pdfSrc"
                    :compact-level="3"
                    @go-to-page="handleGoToPage"
                    @update:open="pageDropdownOpen = $event"
                />
            </template>
            <template v-if="pdfSrc" #zoom-dropdown>
                <PdfZoomDropdown
                    v-model:zoom="zoom"
                    v-model:zoom-mode="zoomMode"
                    v-model:fit-mode="fitMode"
                    v-model:view-mode="viewMode"
                    :effective-zoom="effectiveZoom"
                    :open="zoomDropdownOpen"
                    :disabled="!pdfSrc"
                    :compact-level="2"
                    @update:effective-zoom="effectiveZoom = $event"
                    @update:open="zoomDropdownOpen = $event"
                />
            </template>
        </PdfToolbar>

        <form
            v-if="isSearchOpen"
            class="flex shrink-0 items-center gap-2 border-b border-[var(--ui-border)] bg-[var(--app-chrome)] px-3 py-2"
            @submit.prevent="handleSearch"
        >
            <UInput
                v-model="searchDraft"
                class="min-w-0 flex-1"
                size="sm"
                icon="i-lucide-search"
                :placeholder="t('searchResults.enterSearchTerm')"
                :disabled="!workingCopyPath"
            />
            <UButton
                type="submit"
                icon="i-lucide-search"
                size="sm"
                color="neutral"
                variant="ghost"
                :loading="isSearching"
                :disabled="!workingCopyPath"
                :aria-label="t('sidebar.search', undefined)"
            />
        </form>

        <UAlert
            v-if="openError"
            color="error"
            variant="soft"
            class="mx-3 mt-2 shrink-0"
            :description="openError"
            :ui="{ title: 'sr-only' }"
        />
        <UAlert
            v-if="isSearchOpen && searchError"
            color="error"
            variant="soft"
            class="mx-3 mt-2 shrink-0"
            :description="searchError"
            :ui="{ title: 'sr-only' }"
        />

        <section
            v-if="!pdfSrc"
            class="min-h-0 flex-1"
        >
            <PdfEmptyState
                :recent-files="recentFiles"
                :recent-files-resolved="recentFilesResolved"
                :open-batch-progress="null"
                :open-in-progress="isOpening"
                @open-file="handleOpen"
                @open-recent="openRecent"
                @remove-recent="removeRecent"
                @clear-recent="clearRecent"
            />
        </section>

        <section v-else class="min-h-0 flex-1">
            <ClientOnly>
                <PdfViewer
                    ref="pdfViewerRef"
                    :src="pdfSrc"
                    :source-pdf-data="pdfData"
                    :zoom="zoom"
                    :zoom-mode="zoomMode"
                    :fit-mode="fitMode"
                    :view-mode="viewMode"
                    :continuous-scroll="continuousScroll"
                    :drag-mode="dragMode"
                    show-annotations
                    :annotation-tool="'none'"
                    :search-page-matches="pageMatches"
                    :current-search-match="currentResult"
                    :working-copy-path="workingCopyPath"
                    @update:zoom="zoom = $event"
                    @update:zoom-mode="zoomMode = $event"
                    @update:fit-mode="fitMode = $event"
                    @update:effective-zoom="effectiveZoom = $event"
                    @update:current-page="currentPage = $event"
                    @update:total-pages="totalPages = $event"
                    @loading="isViewerLoading = $event"
                />
            </ClientOnly>
        </section>

        <footer
            v-if="pdfSrc"
            class="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--ui-border)] px-3 py-2 text-xs text-[var(--ui-text-muted)]"
        >
            <span>{{ t('annotations.page', undefined) }} {{ currentPage }} / {{ totalPages }}</span>
            <span v-if="isViewerLoading">{{ t('common.loading', undefined) }}</span>
            <span v-else-if="totalMatches > 0">{{ currentMatch }} / {{ totalMatches }}</span>
        </footer>

        <SettingsDialog v-if="showSettings" v-model:open="showSettings" />
    </main>
</template>

<script setup lang="ts">
import type { IRecentFile } from '@contracts/shared';
import type {
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdf';
import ToolbarButton from '@app/components/ToolbarButton.vue';
import PdfEmptyState from '@app/components/pdf/PdfEmptyState.vue';
import PdfPageDropdown from '@app/components/pdf/PdfPageDropdown.vue';
import PdfToolbar from '@app/components/pdf/PdfToolbar.vue';
import PdfZoomDropdown from '@app/components/pdf/PdfZoomDropdown.vue';
import SettingsDialog from '@app/components/SettingsDialog.vue';
import ToolbarOverflowMenu from '@app/components/toolbar/ToolbarOverflowMenu.vue';
import { MOBILE_READER_COMMAND_SURFACE } from '@app/utils/reader-command-surface';

const PdfViewer = defineAsyncComponent(() => import('@app/components/pdf/PdfViewer.vue'));

const { t } = useTypedI18n();
const {
    pdfSrc,
    pdfData,
    workingCopyPath,
    error: openError,
    closeFile,
    openFile,
    openFileDirect,
} = usePdfFile();
const {
    recentFiles,
    isResolved: recentFilesResolved,
    loadRecentFiles,
    removeRecentFile,
    clearRecentFiles,
} = useRecentFiles();
const {
    search,
    pageMatches,
    currentResult,
    currentMatch,
    totalMatches,
    isSearching,
    searchError,
} = usePdfSearch();

const isOpening = ref(false);
const isViewerLoading = ref(false);
const currentPage = ref(1);
const totalPages = ref(0);
const searchDraft = ref('');
const zoom = ref(1);
const effectiveZoom = ref(1);
const zoomMode = ref<TZoomMode>('fit-width');
const fitMode = ref<TFitMode>('width');
const viewMode = ref<TPdfViewMode>('single');
const continuousScroll = ref(true);
const dragMode = ref(false);
const isSearchOpen = ref(false);
const showSettings = ref(false);
const pageDropdownOpen = ref(false);
const zoomDropdownOpen = ref(false);
const overflowMenuOpen = ref(false);
const pdfViewerRef = ref<{ scrollToPage: (pageNumber: number) => void } | null>(null);
const toolbarSurface = MOBILE_READER_COMMAND_SURFACE;

definePageMeta({ preloadWorkspaceShell: false });
useServerSeoMeta({ robots: 'noindex, nofollow' });
useHead(() => ({ title: t('app.title', undefined) }));
onMounted(() => {
    void loadRecentFiles();
});

async function handleOpen() {
    isOpening.value = true;
    try {
        await openFile();
        await loadRecentFiles();
    } finally {
        isOpening.value = false;
    }
}

async function openRecent(file: IRecentFile) {
    isOpening.value = true;
    try {
        await openFileDirect(file.originalPath);
        await loadRecentFiles();
    } finally {
        isOpening.value = false;
    }
}

async function removeRecent(file: IRecentFile) {
    await removeRecentFile(file);
}

async function clearRecent() {
    await clearRecentFiles();
}

async function handleClose() {
    closeFile();
    searchDraft.value = '';
    isSearchOpen.value = false;
    currentPage.value = 1;
    totalPages.value = 0;
    await loadRecentFiles();
}

async function handleSearch() {
    if (!workingCopyPath.value) {
        return;
    }

    await search(searchDraft.value, workingCopyPath.value, totalPages.value);
}

function handleGoToPage(pageNumber: number) {
    currentPage.value = pageNumber;
    pdfViewerRef.value?.scrollToPage(pageNumber);
}

function handleFitWidth() {
    fitMode.value = 'width';
    zoomMode.value = 'fit-width';
}

function handleFitHeight() {
    fitMode.value = 'height';
    zoomMode.value = 'fit-height';
}

function noopToolbarAction() {}
</script>
