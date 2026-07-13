import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TPdfSource } from '@app/types/pdfUi';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    getDocumentRefBaseName,
    getDocumentRefDisplayLabel,
    isBrowserDocumentRef,
} from '@app/utils/documentRef';
import { formatBytes } from '@app/utils/formatters';
import {
    getDocumentFilesCapability,
    getDocumentWindowCapability,
} from '@app/utils/platformDocuments';

type TSaveDotState = 'idle' | 'saving' | 'dirty' | 'clean';
type TReadableRef<T> = ComputedRef<T> | Ref<T>;

function isPathPdfSource(value: TPdfSource | null): value is Extract<TPdfSource, { kind: 'path' }> {
    return typeof value === 'object'
        && value !== null
        && 'kind' in value
        && value.kind === 'path';
}

interface IPageStatusBarDeps {
    hasDocument: Ref<boolean>;
    pdfSrc: Ref<TPdfSource | null>;
    pdfData: Ref<Uint8Array | null>;
    originalPath: TReadableRef<TDocumentRef | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
    effectiveZoom: Ref<number>;
    isDocumentVisualPending?: Ref<boolean>;
    canSave: Ref<boolean>;
    isAnySaving: Ref<boolean>;
    isHistoryBusy: Ref<boolean>;
    handleSave: () => Promise<unknown>;
}

export const usePageStatusBar = (deps: IPageStatusBarDeps) => {
    const {
        hasDocument,
        pdfSrc,
        pdfData,
        originalPath,
        workingCopyPath,
        effectiveZoom,
        isDocumentVisualPending,
        canSave,
        isAnySaving,
        isHistoryBusy,
        handleSave,
    } = deps;
    const { t } = useTypedI18n();

    const statusFileName = computed(() => {
        const path = originalPath.value ?? workingCopyPath.value;
        return getDocumentRefBaseName(path) ?? t('status.noFileOpen');
    });
    const statusFilePath = computed(() => {
        const path = originalPath.value ?? workingCopyPath.value;
        return getDocumentRefDisplayLabel(path) ?? t('status.noFileOpen');
    });
    const statusShowInFolderPath = computed(() => {
        const path = originalPath.value ?? workingCopyPath.value;
        if (typeof path !== 'string') {
            return null;
        }

        const normalizedPath = path.trim();
        return normalizedPath.length > 0 ? normalizedPath : null;
    });
    const inMemoryFileSizeBytes = computed(() => {
        if (pdfData.value) {
            return pdfData.value.byteLength;
        }
        if (isPathPdfSource(pdfSrc.value)) {
            return pdfSrc.value.size;
        }
        return null;
    });
    const measurableFilePath = computed(() => {
        if (isDocumentVisualPending?.value || inMemoryFileSizeBytes.value !== null) {
            return null;
        }
        // Renderer file I/O is authorized only for the adopted managed copy.
        // The original path may intentionally outlive the visual during close
        // so it can label Recent/status UI, but it must never trigger file:stat.
        const path = workingCopyPath.value;
        return typeof path === 'string' && path.trim().length > 0 ? path : null;
    });
    const statFileSizeBytes = ref<number | null>(null);
    watch(measurableFilePath, async (path) => {
        if (!path) {
            statFileSizeBytes.value = null;
            return;
        }
        try {
            const { size } = await getDocumentFilesCapability().statFile(path);
            if (measurableFilePath.value === path) {
                statFileSizeBytes.value = size;
            }
        } catch {
            if (measurableFilePath.value === path) {
                statFileSizeBytes.value = null;
            }
        }
    }, { immediate: true });
    const statusFileSizeBytes = computed(() => inMemoryFileSizeBytes.value ?? statFileSizeBytes.value);
    const statusFileSizeLabel = computed(() => {
        if (statusFileSizeBytes.value === null) {
            return t('status.fileSizeUnknown');
        }
        return t('status.fileSizeValue', { size: formatBytes(statusFileSizeBytes.value) });
    });
    const statusZoomLabel = computed(() => {
        if (!hasDocument.value || isDocumentVisualPending?.value) {
            return t('status.zoomUnknown');
        }
        return t('status.zoomValue', { zoom: Math.round(effectiveZoom.value * 100) });
    });
    const statusSaveDotState = computed<TSaveDotState>(() => {
        if (!pdfSrc.value) {
            return 'idle';
        }
        if (isAnySaving.value) {
            return 'saving';
        }
        if (canSave.value) {
            return 'dirty';
        }
        return 'clean';
    });
    const statusSaveDotClass = computed(() => `is-${statusSaveDotState.value}`);
    const statusSaveDotCanSave = computed(() => (
        !!pdfSrc.value
        && canSave.value
        && !isAnySaving.value
        && !isHistoryBusy.value
    ));
    const statusSaveDotTooltip = computed(() => {
        if (statusSaveDotState.value === 'idle') {
            return t('status.noFileOpen');
        }
        if (statusSaveDotState.value === 'saving') {
            return t('status.savingChanges');
        }
        if (statusSaveDotState.value === 'dirty') {
            return t('status.unsavedChanges');
        }
        return t('status.allSaved');
    });
    const statusSaveDotAriaLabel = computed(() => {
        if (statusSaveDotState.value === 'dirty') {
            return t('status.saveChanges');
        }
        if (statusSaveDotState.value === 'saving') {
            return t('status.savingChanges');
        }
        if (statusSaveDotState.value === 'clean') {
            return t('status.allSaved');
        }
        return t('status.noFileOpen');
    });
    const statusCanShowInFolder = computed(() => {
        const path = statusShowInFolderPath.value;
        return path !== null && !isBrowserDocumentRef(path);
    });
    const statusShowInFolderUnavailableLabel = computed(() => {
        const path = statusShowInFolderPath.value;
        return path && isBrowserDocumentRef(path)
            ? t('status.showInFolderUnavailableWeb')
            : t('status.noFileOpen');
    });
    const statusShowInFolderTooltip = computed(() => statusCanShowInFolder.value
        ? t('status.showInFolder')
        : statusShowInFolderUnavailableLabel.value);
    const statusShowInFolderAriaLabel = computed(() => statusCanShowInFolder.value
        ? t('status.showInFolder')
        : statusShowInFolderUnavailableLabel.value);

    async function handleStatusSaveClick() {
        if (!statusSaveDotCanSave.value) {
            return;
        }
        await handleSave();
    }

    async function handleStatusShowInFolderClick() {
        const path = statusShowInFolderPath.value;
        if (!path || !statusCanShowInFolder.value) {
            return;
        }

        try {
            await getDocumentWindowCapability().showItemInFolder(path);
        } catch {
            // Ignore failures; status bar action is best-effort.
        }
    }

    return {
        statusFileName,
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
    };
};
