<template>
    <main class="flex h-dvh min-h-0 flex-col bg-[var(--ui-bg)] text-[var(--ui-text)]">
        <PdfToolbar
            :has-pdf="Boolean(activePdfSrc)"
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
            <template v-if="activePdfSrc" #app-menu>
                <ToolbarButton
                    icon="lucide:x"
                    :tooltip="t('annotationProperties.close', undefined)"
                    @click="handleClose"
                />
            </template>
            <template #overflow-menu="{ collapseTier }">
                <ToolbarButton
                    v-if="activePdfSrc"
                    icon="lucide:search"
                    :active="isSearchOpen"
                    :tooltip="t('sidebar.search', undefined)"
                    @click="isSearchOpen = !isSearchOpen"
                />
                <ToolbarOverflowMenu
                    :open="overflowMenuOpen"
                    :collapse-tier="Math.max(collapseTier, 3)"
                    :can-save="false"
                    :can-save-as="false"
                    :can-print="false"
                    :can-undo="false"
                    :can-redo="false"
                    :can-toggle-sidebar="false"
                    :can-capture-region="false"
                    :can-crop="false"
                    :can-quick-note="false"
                    :has-pdf="Boolean(activePdfSrc)"
                    :is-any-saving="false"
                    :is-history-busy="false"
                    :is-exporting-docx="false"
                    :is-preparing-print="false"
                    :can-export-docx="false"
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
                    @open-file="handleOpen"
                    @capture-region="noopToolbarAction"
                    @crop="noopToolbarAction"
                    @save="noopToolbarAction"
                    @save-as="noopToolbarAction"
                    @print="noopToolbarAction"
                    @export-docx="noopToolbarAction"
                    @undo="noopToolbarAction"
                    @redo="noopToolbarAction"
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
            <template v-if="activePdfSrc" #page-dropdown>
                <PdfPageDropdown
                    v-model="currentPage"
                    :open="pageDropdownOpen"
                    :total-pages="totalPages"
                    :view-mode="viewMode"
                    :disabled="!activePdfSrc"
                    :compact-level="3"
                    @go-to-page="handleGoToPage"
                    @update:open="pageDropdownOpen = $event"
                />
            </template>
            <template v-if="activePdfSrc" #zoom-dropdown>
                <PdfZoomDropdown
                    v-model:zoom="zoom"
                    v-model:zoom-mode="zoomMode"
                    v-model:fit-mode="fitMode"
                    v-model:view-mode="viewMode"
                    :effective-zoom="effectiveZoom"
                    :open="zoomDropdownOpen"
                    :disabled="!activePdfSrc"
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
            v-if="!activePdfSrc && !bridgeDocumentStatus && !bridgeDocumentError"
            class="min-h-0 flex-1"
        >
            <PdfEmptyState
                :recent-files="displayedRecentFiles"
                :recent-files-resolved="displayedRecentFilesResolved"
                :open-batch-progress="null"
                :open-in-progress="isOpening"
                @open-file="handleOpen"
                @open-recent="openRecent"
                @remove-recent="removeRecent"
                @clear-recent="clearRecent"
            />
        </section>

        <section
            v-else-if="bridgeDocumentStatus || bridgeDocumentError"
            class="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-[var(--ui-text-muted)]"
        >
            <div class="space-y-2">
                <UIcon
                    :name="bridgeDocumentError ? 'i-lucide-alert-circle' : 'i-lucide-loader-circle'"
                    :class="[
                        'mx-auto size-6',
                        bridgeDocumentError ? 'text-[var(--ui-error)]' : 'animate-spin',
                    ]"
                />
                <p>{{ bridgeDocumentError ?? bridgeDocumentStatus }}</p>
            </div>
        </section>

        <section v-else class="min-h-0 flex-1">
            <ClientOnly>
                <PdfViewer
                    ref="pdfViewerRef"
                    :src="activePdfSrc"
                    :source-pdf-data="bridgePdfSrc ? null : pdfData"
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
                    :working-copy-path="bridgePdfSrc ? null : workingCopyPath"
                    @update:zoom="zoom = $event"
                    @update:zoom-mode="zoomMode = $event"
                    @update:fit-mode="fitMode = $event"
                    @update:effective-zoom="effectiveZoom = $event"
                    @update:current-page="currentPage = $event"
                    @update:total-pages="totalPages = $event"
                    @update:document="handleViewerDocumentUpdate"
                    @loading="isViewerLoading = $event"
                />
            </ClientOnly>
        </section>

        <footer
            v-if="activePdfSrc"
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
    TPdfSource,
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
import {
    MOBILE_READER_COMMAND_SURFACE,
    listReaderCommandsForPlacement,
} from '@app/utils/reader-command-surface';
import { registerExternalDocumentReader } from '@app/utils/external-document-readers';
import { createUuid } from '@app/utils/uuid';
import {
    decodeBase64Bytes,
    isReactNativeWebViewHost,
    postViewerMessage,
    subscribeToHostMessages,
} from '@app/utils/rn-webview-bridge';
import type { THostToViewerMessage } from '@contracts/rn-webview-protocol';

const PdfViewer = defineAsyncComponent(() => import('@app/components/pdf/PdfViewer.vue'));

const { t } = useTypedI18n();
const {
    pdfSrc,
    pdfData,
    workingCopyPath,
    error: openError,
    closeFile,
    loadPdfFromData,
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
const hasMounted = ref(false);
const pageDropdownOpen = ref(false);
const zoomDropdownOpen = ref(false);
const overflowMenuOpen = ref(false);
const bridgeDocumentId = ref<string | null>(null);
const bridgeDocumentTitle = ref<string | undefined>();
const bridgeDocumentStatus = ref<string | null>(null);
const bridgeDocumentError = ref<string | null>(null);
const bridgePdfSrc = shallowRef<TPdfSource | null>(null);
const bridgeRecentFiles = ref<IRecentFile[]>([]);
const pdfViewerRef = ref<{ scrollToPage: (pageNumber: number) => void } | null>(null);
const toolbarSurface = MOBILE_READER_COMMAND_SURFACE;
let unsubscribeHostMessages: (() => void) | null = null;
let viewerReadyTimer: number | null = null;
let bridgeDocumentLoadTimer: number | null = null;
let unregisterBridgeReader: (() => void) | null = null;
const chunkedDocuments = new Map<string, {
    message: Extract<THostToViewerMessage, { type: 'document:open-chunked' }>;
    chunks: string[];
    receivedCount: number;
}>();
const rangeRequests = new Map<string, {
    resolve: (bytes: Uint8Array) => void;
    reject: (error: Error) => void;
    timer: number;
}>();
const activePdfSrc = computed(() => bridgePdfSrc.value ?? pdfSrc.value);
const isNativeBridgeHost = computed(() => hasMounted.value && isReactNativeWebViewHost());
const displayedRecentFiles = computed(() => (isNativeBridgeHost.value ? bridgeRecentFiles.value : recentFiles.value));
const displayedRecentFilesResolved = computed(() => (isNativeBridgeHost.value ? true : recentFilesResolved.value));

definePageMeta({ preloadWorkspaceShell: false });
useServerSeoMeta({ robots: 'noindex, nofollow' });
useHead(() => ({ title: t('app.title', undefined) }));
onMounted(() => {
    hasMounted.value = true;
    unsubscribeHostMessages = subscribeToHostMessages(handleHostMessage);
    if (isNativeBridgeHost.value) {
        postViewerMessage({ type: 'recent-files:request' });
    } else {
        void loadRecentFiles();
    }
    announceViewerReady();
});

onUnmounted(() => {
    unsubscribeHostMessages?.();
    unsubscribeHostMessages = null;
    unregisterBridgeReader?.();
    unregisterBridgeReader = null;
    for (const pending of rangeRequests.values()) {
        window.clearTimeout(pending.timer);
        pending.reject(new Error('Mobile reader route unloaded before range read completed.'));
    }
    rangeRequests.clear();
    if (viewerReadyTimer) {
        window.clearTimeout(viewerReadyTimer);
        viewerReadyTimer = null;
    }
    clearBridgeDocumentLoadTimer();
});

watch(
    [
        currentPage,
        totalPages,
    ],
    ([
        page,
        pageCount,
    ]) => {
        if (pageCount <= 0) {
            return;
        }

        postViewerMessage({
            type: 'reader:page-changed',
            page,
            pageCount,
        });
    },
);

watch(
    totalPages,
    (pageCount) => {
        if (pageCount <= 0 || bridgeDocumentId.value) {
            return;
        }

        postViewerMessage({
            type: 'document:loaded',
            documentId: null,
            pageCount,
            title: bridgeDocumentTitle.value,
        });
    },
);

watch(
    [
        () => Boolean(pdfSrc.value),
        () => Boolean(bridgePdfSrc.value),
        dragMode,
        continuousScroll,
        viewMode,
        () => zoomMode.value,
    ],
    () => {
        postViewerMessage({
            type: 'reader:commands-changed',
            commands: listReaderCommandsForPlacement(toolbarSurface, 'menu').map(command => ({
                id: command,
                enabled: commandRequiresDocument(command) ? Boolean(activePdfSrc.value) : true,
                visible: true,
                selected:
                    command === 'continuous-scroll'
                        ? continuousScroll.value
                        : command === 'drag-mode'
                            ? dragMode.value
                            : command === 'text-select'
                                ? !dragMode.value
                                : command === 'fit-width'
                                    ? zoomMode.value === 'fit-width'
                                    : command === 'fit-height'
                                        ? zoomMode.value === 'fit-height'
                                        : undefined,
            })),
        });
    },
    { immediate: true },
);

async function handleOpen() {
    if (isNativeBridgeHost.value) {
        postViewerMessage({ type: 'document:request-open' });
        return;
    }

    isOpening.value = true;
    try {
        bridgePdfSrc.value = null;
        bridgeDocumentError.value = null;
        unregisterBridgeReader?.();
        unregisterBridgeReader = null;
        await openFile();
        await loadRecentFiles();
    } finally {
        isOpening.value = false;
    }
}

async function openRecent(file: IRecentFile) {
    if (isNativeBridgeHost.value) {
        postViewerMessage({
            type: 'recent-file:open',
            ref: file.originalPath,
        });
        return;
    }

    isOpening.value = true;
    try {
        bridgePdfSrc.value = null;
        bridgeDocumentError.value = null;
        unregisterBridgeReader?.();
        unregisterBridgeReader = null;
        await openFileDirect(file.originalPath);
        await loadRecentFiles();
    } finally {
        isOpening.value = false;
    }
}

async function removeRecent(file: IRecentFile) {
    if (isNativeBridgeHost.value) {
        postViewerMessage({
            type: 'recent-file:remove',
            ref: file.originalPath,
        });
        return;
    }

    await removeRecentFile(file);
}

async function clearRecent() {
    if (isNativeBridgeHost.value) {
        postViewerMessage({ type: 'recent-files:clear' });
        return;
    }

    await clearRecentFiles();
}

async function handleClose() {
    closeFile();
    bridgePdfSrc.value = null;
    bridgeDocumentId.value = null;
    bridgeDocumentTitle.value = undefined;
    bridgeDocumentStatus.value = null;
    bridgeDocumentError.value = null;
    unregisterBridgeReader?.();
    unregisterBridgeReader = null;
    searchDraft.value = '';
    isSearchOpen.value = false;
    currentPage.value = 1;
    totalPages.value = 0;
    if (isNativeBridgeHost.value) {
        postViewerMessage({ type: 'recent-files:request' });
    } else {
        await loadRecentFiles();
    }
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

function handleViewerDocumentUpdate(document: { numPages?: number } | null) {
    if (!document || !bridgeDocumentId.value) {
        return;
    }

    const pageCount = Number(document.numPages) || totalPages.value;
    if (pageCount <= 0) {
        return;
    }

    bridgeDocumentStatus.value = null;
    bridgeDocumentError.value = null;
    clearBridgeDocumentLoadTimer();
    postViewerMessage({
        type: 'document:loaded',
        documentId: bridgeDocumentId.value,
        pageCount,
        title: bridgeDocumentTitle.value,
    });
}

function handleFitWidth() {
    fitMode.value = 'width';
    zoomMode.value = 'fit-width';
}

function handleFitHeight() {
    fitMode.value = 'height';
    zoomMode.value = 'fit-height';
}

async function handleHostMessage(message: THostToViewerMessage) {
    if (message.type === 'host:ping') {
        postViewerMessage({ type: 'viewer:ready' });
        return;
    }
    if (message.type === 'recent-files:changed') {
        bridgeRecentFiles.value = message.recentFiles;
        return;
    }
    if (message.type === 'document:open') {
        await openBridgeDocument(message);
        return;
    }
    if (message.type === 'document:open-url') {
        openUrlBridgeDocument(message);
        return;
    }
    if (message.type === 'document:open-ranged') {
        openRangedBridgeDocument(message);
        return;
    }
    if (message.type === 'document:open-chunked') {
        beginChunkedBridgeDocument(message);
        return;
    }
    if (message.type === 'document:chunk') {
        await appendBridgeDocumentChunk(message);
        return;
    }
    if (message.type === 'document:range') {
        resolveBridgeRangeRequest(message);
        return;
    }
    if (message.type === 'reader:go-to-page') {
        handleGoToPage(message.page);
        return;
    }
    if (message.type === 'reader:execute-command') {
        await executeBridgeCommand(message.command.id);
        return;
    }
    if (message.type === 'search:run') {
        searchDraft.value = message.query;
        isSearchOpen.value = true;
        await handleSearch();
    }
}

function beginChunkedBridgeDocument(message: Extract<THostToViewerMessage, { type: 'document:open-chunked' }>) {
    bridgeDocumentStatus.value = `Receiving ${message.suggestedName ?? 'document'} 0 / ${message.chunkCount}`;
    chunkedDocuments.set(message.documentId, {
        message,
        chunks: Array.from({ length: message.chunkCount }, () => ''),
        receivedCount: 0,
    });
    postViewerMessage({
        type: 'document:chunk-ack',
        documentId: message.documentId,
        index: -1,
        receivedCount: 0,
        chunkCount: message.chunkCount,
    });
}

function openUrlBridgeDocument(message: Extract<THostToViewerMessage, { type: 'document:open-url' }>) {
    if (!message.url) {
        bridgeDocumentStatus.value = null;
        bridgeDocumentError.value = 'The selected document did not provide a reader URL.';
        postViewerMessage({
            type: 'viewer:error',
            code: 'missing-document-url',
            message: 'RN URL document open requires a URL.',
        });
        return;
    }

    closeFile();
    bridgePdfSrc.value = null;
    bridgeDocumentError.value = null;
    unregisterBridgeReader?.();
    unregisterBridgeReader = null;
    bridgeDocumentId.value = message.documentId;
    bridgeDocumentTitle.value = message.suggestedName;
    bridgeDocumentStatus.value = `Opening ${message.suggestedName ?? 'document'}`;
    currentPage.value = 1;
    totalPages.value = 0;
    searchDraft.value = '';
    isSearchOpen.value = false;
    postViewerMessage({
        type: 'document:open-started',
        documentId: message.documentId,
        title: message.suggestedName,
    });
    bridgePdfSrc.value = {
        kind: 'url',
        url: message.url,
        size: message.size,
    };
    armBridgeDocumentLoadTimer(message.documentId, message.url);
}

function openRangedBridgeDocument(message: Extract<THostToViewerMessage, { type: 'document:open-ranged' }>) {
    if (!message.size || message.size <= 0) {
        bridgeDocumentStatus.value = null;
        bridgeDocumentError.value = 'The selected document cannot be opened because its size is unknown.';
        postViewerMessage({
            type: 'viewer:error',
            code: 'missing-document-size',
            message: 'RN ranged document open requires a positive document size.',
        });
        return;
    }

    closeFile();
    bridgePdfSrc.value = null;
    bridgeDocumentError.value = null;
    unregisterBridgeReader?.();
    unregisterBridgeReader = registerExternalDocumentReader(message.ref, {readRange: (offset, length) => requestBridgeRange(message.ref, offset, length)});
    bridgeDocumentId.value = message.documentId;
    bridgeDocumentTitle.value = message.suggestedName;
    bridgeDocumentStatus.value = `Opening ${message.suggestedName ?? 'document'}`;
    currentPage.value = 1;
    totalPages.value = 0;
    searchDraft.value = '';
    isSearchOpen.value = false;
    postViewerMessage({
        type: 'document:open-started',
        documentId: message.documentId,
        title: message.suggestedName,
    });
    bridgePdfSrc.value = {
        kind: 'path',
        path: message.ref,
        size: message.size,
    };
    armBridgeDocumentLoadTimer(message.documentId, message.ref);
}

async function appendBridgeDocumentChunk(message: Extract<THostToViewerMessage, { type: 'document:chunk' }>) {
    const pending = chunkedDocuments.get(message.documentId);
    if (!pending) {
        postViewerMessage({
            type: 'viewer:error',
            code: 'missing-document-chunk-session',
            message: 'Received a document chunk before document metadata.',
        });
        return;
    }

    if (!pending.chunks[message.index]) {
        pending.receivedCount += 1;
    }
    pending.chunks[message.index] = message.base64;
    bridgeDocumentStatus.value = `Receiving ${pending.message.suggestedName ?? 'document'} ${pending.receivedCount} / ${pending.message.chunkCount}`;
    postViewerMessage({
        type: 'document:chunk-ack',
        documentId: message.documentId,
        index: message.index,
        receivedCount: pending.receivedCount,
        chunkCount: pending.message.chunkCount,
    });

    if (pending.receivedCount < pending.message.chunkCount) {
        return;
    }

    chunkedDocuments.delete(message.documentId);
    await openBridgeDocument({
        ...pending.message,
        type: 'document:open',
        base64: pending.chunks.join(''),
    });
}

function requestBridgeRange(ref: string, offset: number, length: number) {
    const requestId = createUuid();
    postViewerMessage({
        type: 'document:request-range',
        requestId,
        ref,
        offset,
        length,
    });

    return new Promise<Uint8Array>((resolve, reject) => {
        const timer = window.setTimeout(() => {
            rangeRequests.delete(requestId);
            reject(new Error(`Timed out reading document range at ${offset}.`));
        }, 15_000);
        rangeRequests.set(requestId, {
            resolve,
            reject,
            timer,
        });
    });
}

function resolveBridgeRangeRequest(message: Extract<THostToViewerMessage, { type: 'document:range' }>) {
    const pending = rangeRequests.get(message.requestId);
    if (!pending) {
        return;
    }

    window.clearTimeout(pending.timer);
    rangeRequests.delete(message.requestId);
    if (message.error) {
        pending.reject(new Error(message.error));
        return;
    }

    pending.resolve(decodeBase64Bytes(message.base64));
}

async function openBridgeDocument(message: Extract<THostToViewerMessage, { type: 'document:open' }>) {
    if (!message.base64) {
        bridgeDocumentStatus.value = null;
        bridgeDocumentError.value = 'The selected document was not transferred to the reader.';
        postViewerMessage({
            type: 'viewer:error',
            code: 'missing-document-bytes',
            message: 'The first RN spike requires base64 document bytes.',
        });
        return;
    }

    try {
        const bytes = decodeBase64Bytes(message.base64);
        if (!bytes.byteLength) {
            throw new Error('The selected document was empty.');
        }

        bridgePdfSrc.value = null;
        bridgeDocumentError.value = null;
        unregisterBridgeReader?.();
        unregisterBridgeReader = null;
        bridgeDocumentId.value = message.documentId;
        bridgeDocumentTitle.value = message.suggestedName;
        bridgeDocumentStatus.value = `Opening ${message.suggestedName ?? 'document'}`;
        postViewerMessage({
            type: 'document:open-started',
            documentId: message.documentId,
            title: message.suggestedName,
        });
        currentPage.value = 1;
        totalPages.value = 0;
        searchDraft.value = '';
        isSearchOpen.value = false;
        closeFile();
        await loadPdfFromData(bytes, {
            pushHistory: false,
            persistWorkingCopy: false,
        });
        bridgeDocumentStatus.value = null;
    } catch (error) {
        bridgeDocumentStatus.value = null;
        bridgeDocumentError.value = error instanceof Error ? error.message : String(error);
        postViewerMessage({
            type: 'viewer:error',
            code: 'document-open-failed',
            message: error instanceof Error ? error.message : String(error),
        });
    }
}

function clearBridgeDocumentLoadTimer() {
    if (!bridgeDocumentLoadTimer) {
        return;
    }

    window.clearTimeout(bridgeDocumentLoadTimer);
    bridgeDocumentLoadTimer = null;
}

function armBridgeDocumentLoadTimer(documentId: string, source: string) {
    clearBridgeDocumentLoadTimer();
    bridgeDocumentLoadTimer = window.setTimeout(() => {
        if (bridgeDocumentId.value !== documentId || totalPages.value > 0) {
            return;
        }

        const message = `Timed out while PDF.js was loading ${source}.`;
        bridgeDocumentStatus.value = null;
        bridgeDocumentError.value = message;
        postViewerMessage({
            type: 'viewer:error',
            code: 'document-url-load-timeout',
            message,
        });
    }, 30_000);
}

async function executeBridgeCommand(command: string) {
    if (command === 'open-file') {
        await handleOpen();
    } else if (command === 'fit-width') {
        handleFitWidth();
    } else if (command === 'fit-height') {
        handleFitHeight();
    } else if (command === 'continuous-scroll') {
        continuousScroll.value = !continuousScroll.value;
    } else if (command === 'drag-mode') {
        dragMode.value = true;
    } else if (command === 'text-select') {
        dragMode.value = false;
    } else if (command === 'settings') {
        showSettings.value = true;
    }
}

function commandRequiresDocument(command: string) {
    return ![
        'open-file',
        'settings',
        'fullscreen',
    ].includes(command);
}

function noopToolbarAction() {}

function announceViewerReady(attempt = 0) {
    const posted = postViewerMessage({ type: 'viewer:ready' });
    if (posted) {
        return;
    }

    if (attempt >= 40) {
        return;
    }

    viewerReadyTimer = window.setTimeout(() => {
        announceViewerReady(attempt + 1);
    }, Math.min(250 + attempt * 100, 1_500));
}
</script>
