<template>
    <div
        class="workspace-host-document-open-fallback"
        role="status"
        aria-live="polite"
        :aria-label="t('common.loading')"
    >
        <DjvuBanner
            v-if="isPendingDjvuPath"
            visible
            is-opening
        />
        <WorkspaceDocumentTransitionSkeleton />
    </div>

    <Teleport v-if="canTeleportStatus" to="#editor-global-status-host">
        <PdfStatusBar
            :file-path="statusFilePath"
            :file-size-label="statusFileSizeLabel"
            :zoom-label="statusZoomLabel"
            :can-show-in-folder="statusCanShowInFolder"
            :show-in-folder-tooltip="statusShowInFolderTooltip"
            :show-in-folder-aria-label="statusShowInFolderAriaLabel"
            :save-dot-class="statusSaveDotClass"
            :save-dot-tooltip="statusSaveDotTooltip"
            :save-dot-aria-label="statusSaveDotAriaLabel"
            :can-save="statusSaveDotCanSave"
            @show-in-folder="handleStatusShowInFolderClick"
            @save="handleStatusSaveClick"
        />
    </Teleport>
</template>

<script setup lang="ts">
import type { TDocumentRef } from '@contracts/documentRef';
import type { TPdfSource } from '@app/types/pdfUi';
import { PdfStatusBar } from '@app/modules/pdf-viewer/public/component-exports/pdfStatusBar';
import { DjvuBanner } from '@app/modules/djvu-viewer/public/component-exports/djvuBanner';
import { usePageStatusBar } from '@app/modules/workspace-shell/composables/usePageStatusBar';
import WorkspaceDocumentTransitionSkeleton from '@app/modules/workspace-shell/components/WorkspaceDocumentTransitionSkeleton.vue';
import { getDocumentKindFromPath } from '@app/utils/supportedDocumentPaths';

const props = defineProps<{path: TDocumentRef | null;}>();
const { t } = useTypedI18n();
const isPendingDjvuPath = computed(() => (
    props.path !== null && getDocumentKindFromPath(props.path) === 'djvu'
));
const canTeleportStatus = ref(false);
const statusPath = computed(() => props.path);
const statusHasDocument = ref(false);
const statusPdfSrc = ref<TPdfSource | null>(null);
const statusPdfData = ref<Uint8Array | null>(null);
const statusWorkingCopyPath = ref<TDocumentRef | null>(null);
const statusEffectiveZoom = ref(1);
const statusCanSave = ref(false);
const statusIsAnySaving = ref(false);
const statusIsHistoryBusy = ref(false);

const {
    statusFilePath,
    statusFileSizeLabel,
    statusZoomLabel,
    statusCanShowInFolder,
    statusShowInFolderTooltip,
    statusShowInFolderAriaLabel,
    statusSaveDotClass,
    statusSaveDotCanSave,
    statusSaveDotTooltip,
    statusSaveDotAriaLabel,
    handleStatusSaveClick,
    handleStatusShowInFolderClick,
} = usePageStatusBar({
    hasDocument: statusHasDocument,
    pdfSrc: statusPdfSrc,
    pdfData: statusPdfData,
    originalPath: statusPath,
    workingCopyPath: statusWorkingCopyPath,
    effectiveZoom: statusEffectiveZoom,
    canSave: statusCanSave,
    isAnySaving: statusIsAnySaving,
    isHistoryBusy: statusIsHistoryBusy,
    handleSave: () => Promise.resolve(),
});

function refreshTeleportHosts() {
    if (!import.meta.client) {
        return;
    }

    canTeleportStatus.value = Boolean(document.getElementById('editor-global-status-host'));
}

onMounted(() => {
    refreshTeleportHosts();
    void nextTick(refreshTeleportHosts);
});
</script>

<style scoped>
.workspace-host-document-open-fallback {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    pointer-events: none;
    background: var(--app-pdf-viewer-bg, var(--app-window-bg));
}

.workspace-host-document-open-fallback :deep(.workspace-document-transition-skeleton) {
    flex: 1;
}
</style>
