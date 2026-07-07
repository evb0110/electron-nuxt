import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type {
    IPdfConformanceProfile,
    TPdfSaveMode,
} from '@app/types/pdfContracts';
import type { TPdfSource } from '@app/types/pdfUi';
import type { TPdfRasterDisplayProfile } from '@app/types/pdfRasterDisplayProfile';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IDocumentRevisionInfo,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import type { IOpenBatchProgressState } from '@app/modules/workspace-shell/composables/openBatchProgressState';
import { getDocumentRefBaseName } from '@app/utils/documentRef';

interface ICreateDocumentSessionStateDeps { isDesktopRuntime: Ref<boolean> | ComputedRef<boolean>; }

export interface IDocumentSessionState {
    error: Ref<string | null>;
    fileName: ComputedRef<string | null>;
    isDirty: Ref<boolean>;
    isElectron: ComputedRef<boolean>;
    lastSaveMode: Ref<TPdfSaveMode>;
    openBatchProgress: Ref<IOpenBatchProgressState | null>;
    originalPath: Ref<TDocumentRef | null>;
    pdfConformanceProfile: Ref<IPdfConformanceProfile | null>;
    pdfData: ShallowRef<Uint8Array | null>;
    pdfRasterDisplayProfile: Ref<TPdfRasterDisplayProfile | null>;
    pdfReloadSrc: Ref<TPdfSource | null>;
    pdfSrc: Ref<TPdfSource | null>;
    pendingDjvu: Ref<TDocumentRef | null>;
    requiresSaveAsOnFirstSave: Ref<boolean>;
    workingCopyPath: Ref<TDocumentRef | null>;
    documentRevisionInfo: Ref<IDocumentRevisionInfo | null>;
    documentRevisionToken: Ref<TDocumentRevisionToken | null>;
    isActiveWorkingCopy: (path: TDocumentRef) => boolean;
    resetForClose: () => void;
}

export function createDocumentSessionState(
    deps: ICreateDocumentSessionStateDeps,
): IDocumentSessionState {
    const pdfSrc = ref<TPdfSource | null>(null);
    const pdfReloadSrc = ref<TPdfSource | null>(null);
    const pdfData = shallowRef<Uint8Array | null>(null);
    const pdfRasterDisplayProfile = ref<TPdfRasterDisplayProfile | null>(null);
    const workingCopyPath = ref<TDocumentRef | null>(null);
    const documentRevisionInfo = ref<IDocumentRevisionInfo | null>(null);
    const documentRevisionToken = ref<TDocumentRevisionToken | null>(null);
    const originalPath = ref<TDocumentRef | null>(null);
    const error = ref<string | null>(null);
    const isDirty = ref(false);
    const pdfConformanceProfile = ref<IPdfConformanceProfile | null>(null);
    const lastSaveMode = ref<TPdfSaveMode>('rewrite');
    const requiresSaveAsOnFirstSave = ref(false);
    const pendingDjvu = ref<TDocumentRef | null>(null);
    const openBatchProgress = ref<IOpenBatchProgressState | null>(null);

    const fileName = computed(
        () =>
            getDocumentRefBaseName(workingCopyPath.value) ??
            getDocumentRefBaseName(originalPath.value),
    );
    const isElectron = computed(() => deps.isDesktopRuntime.value);

    function isActiveWorkingCopy(path: TDocumentRef) {
        return workingCopyPath.value === path;
    }

    function resetForClose() {
        pdfSrc.value = null;
        pdfReloadSrc.value = null;
        pdfData.value = null;
        pdfRasterDisplayProfile.value = null;
        workingCopyPath.value = null;
        documentRevisionInfo.value = null;
        documentRevisionToken.value = null;
        originalPath.value = null;
        error.value = null;
        isDirty.value = false;
        pendingDjvu.value = null;
        openBatchProgress.value = null;
        requiresSaveAsOnFirstSave.value = false;
        lastSaveMode.value = 'rewrite';
    }

    return {
        error,
        fileName,
        isDirty,
        isElectron,
        isActiveWorkingCopy,
        lastSaveMode,
        openBatchProgress,
        originalPath,
        pdfConformanceProfile,
        pdfData,
        pdfRasterDisplayProfile,
        pdfReloadSrc,
        pdfSrc,
        pendingDjvu,
        requiresSaveAsOnFirstSave,
        resetForClose,
        workingCopyPath,
        documentRevisionInfo,
        documentRevisionToken,
    };
}
