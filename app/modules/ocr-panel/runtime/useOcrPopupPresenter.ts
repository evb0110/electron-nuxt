import type { TDocumentRef } from '@contracts/documentRef';
import type { IDebugLogEntry } from '@contracts/electronApiCommon';
import type { TOcrProgressPhase } from '@contracts/electronApiOcr';
import type { TTranslationKey } from '@i18n-app';
import {
    useClipboard,
    useTimeoutFn,
} from '@vueuse/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
    MaybeRefOrGetter,
    WritableComputedRef,
} from 'vue';
import { useOcr } from '@app/composables/useOcr';
import { useTypedI18n } from '@app/composables/useTypedI18n';
import type { IAgentOcrRunOptions } from '@app/types/ocrAgent';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getSettingsCapability } from '@app/utils/getSettingsCapability';
import type { IOcrSearchablePdfResult } from '@app/utils/ocr/ocrTypes';
import { resolveOcrExportLanguages } from '@app/utils/ocr/resolveOcrExportLanguages';
import {
    applyAgentOcrOptionsToSettings,
    cloneOcrSettingsSnapshot,
    normalizeSelectedOcrLanguages,
    resolveOcrPageSegmentationModeFromSelectValue,
    resolveOcrPageSegmentationSelectValue,
    resolveQualityProfileSettings,
} from '@app/modules/ocr-panel/runtime/ocrPopupSettings';

type TOcrViewState = 'configure' | 'running' | 'results' | 'error';

export interface IOcrPopupCompletePayload extends IOcrSearchablePdfResult {
    sourceWorkingCopyPath: TDocumentRef;
    sourcePageToRestore: number;
}

export interface IOcrPopupPresenterContext {
    pdfDocument: MaybeRefOrGetter<PDFDocumentProxy | null>;
    currentPage: MaybeRefOrGetter<number>;
    totalPages: MaybeRefOrGetter<number>;
    workingCopyPath: MaybeRefOrGetter<TDocumentRef | null>;
    disabled: MaybeRefOrGetter<boolean>;
    externalError: MaybeRefOrGetter<string | null | undefined>;
}

export interface IOcrPopupPresenterEvents {
    onRunningChange: (value: boolean) => void;
    onOcrComplete: (payload: IOcrPopupCompletePayload) => void;
    onExportDocx: (selectedLanguages: string[]) => void;
}

export interface IOcrPopupPresenterOptions {
    isOpen: WritableComputedRef<boolean>;
    context: IOcrPopupPresenterContext;
    events: IOcrPopupPresenterEvents;
}

const ocrProgressStageKeys = {
    preparing: 'ocr.preparing',
    'model-prep': 'ocr.progressStage.modelPrep',
    'pdf-prep': 'ocr.progressStage.pdfPrep',
    'dpi-inspection': 'ocr.progressStage.dpiInspection',
    'page-size-probing': 'ocr.progressStage.pageSizeProbing',
    merging: 'ocr.progressStage.merging',
    indexing: 'ocr.progressStage.indexing',
} as const satisfies Record<Exclude<TOcrProgressPhase, 'processing'>, TTranslationKey>;

function formatLanguagesForDiagnostics(languages: readonly string[]) {
    return languages.length > 0
        ? languages.join(',')
        : '-';
}

function formatDebugLogEntry(entry: IDebugLogEntry) {
    return `[${entry.timestamp}] [${entry.source}] ${entry.message}`;
}

export const useOcrPopupPresenter = ({
    context,
    events,
    isOpen,
}: IOcrPopupPresenterOptions) => {
    const { t } = useTypedI18n();
    const { copy: copyClipboardText } = useClipboard();
    const {
        settings,
        activeRunSettings,
        lastCompletedRunSettings,
        progress,
        results,
        error,
        hasResults,
        progressPercent,
        latinCyrillicLanguages,
        greekLanguages,
        rtlLanguages,
        loadLanguages,
        runOcr,
        cancelOcr,
        clearResults,
        clearRunSettingsHistory,
    } = useOcr();

    const isCopyingLogs = ref(false);
    const copyLogsState = ref<'idle' | 'copied' | 'failed'>('idle');
    const showSuccessState = ref(false);
    const activeOcrSourcePath = ref<TDocumentRef | null>(null);
    const activeOcrSourcePage = ref<number | null>(null);
    const pendingAppliedOcrRequestId = ref<string | null>(null);

    const {
        start: startCopyLogsStateReset,
        stop: stopCopyLogsStateReset,
    } = useTimeoutFn(() => {
        copyLogsState.value = 'idle';
    }, 2500, { immediate: false });
    const {
        start: startSuccessStateReset,
        stop: stopSuccessStateReset,
    } = useTimeoutFn(() => {
        showSuccessState.value = false;
    }, 3000, { immediate: false });

    const currentPage = computed(() => toValue(context.currentPage));
    const totalPages = computed(() => toValue(context.totalPages));
    const workingCopyPath = computed(() => toValue(context.workingCopyPath));
    const pdfDocument = computed(() => toValue(context.pdfDocument));
    const disabled = computed(() => toValue(context.disabled));
    const externalError = computed(() => toValue(context.externalError));
    const effectiveError = computed(() => error.value ?? externalError.value ?? null);
    const isRunSettingsLocked = computed(() => progress.value.isRunning);
    const viewState = computed<TOcrViewState>(() => {
        if (progress.value.isRunning) {
            return 'running';
        }
        if (hasResults.value) {
            return 'results';
        }
        if (effectiveError.value !== null) {
            return 'error';
        }
        return 'configure';
    });
    const availableLanguageCodes = computed(() => new Set([
        ...latinCyrillicLanguages.value,
        ...greekLanguages.value,
        ...rtlLanguages.value,
    ].map(lang => lang.code)));
    const hasSelectedAvailableLanguage = computed(() =>
        settings.value.selectedLanguages.some(code => availableLanguageCodes.value.has(code)),
    );
    const canRunOcr = computed(() =>
        !disabled.value
        && !progress.value.isRunning
        && hasSelectedAvailableLanguage.value
        && Boolean(pdfDocument.value)
        && Boolean(workingCopyPath.value),
    );
    const showCustomRange = computed(() => settings.value.pageRange === 'custom');
    const progressStatusText = computed(() => {
        if (progress.value.phase === 'processing') {
            return t('ocr.processingPage', {
                page: progress.value.currentPage,
                processed: progress.value.processedCount,
                total: progress.value.totalPages,
            });
        }

        return t(ocrProgressStageKeys[progress.value.phase], undefined);
    });
    const triggerTooltip = computed(() => {
        if (progress.value.isRunning) {
            return progressStatusText.value;
        }

        if (showSuccessState.value) {
            return t('ocr.complete');
        }

        return t('ocr.button');
    });
    const copyLogsTooltip = computed(() => {
        if (copyLogsState.value === 'copied') {
            return t('ocr.logsCopied');
        }
        if (copyLogsState.value === 'failed') {
            return t('ocr.logsCopyFailed');
        }
        return t('ocr.copyLogs');
    });
    const hasResultWarning = computed(() => hasResults.value && effectiveError.value !== null);
    const resultStatusText = computed(() => (
        hasResultWarning.value ? t('ocr.partialComplete') : t('ocr.complete')
    ));
    const selectedLanguagesModel = computed({
        get: () => settings.value.selectedLanguages,
        set: (selectedLanguages: string[]) => {
            settings.value = {
                ...settings.value,
                selectedLanguages: normalizeSelectedOcrLanguages(selectedLanguages),
            };
        },
    });
    const pageSegmentationModeSelectValue = computed({
        get: () => resolveOcrPageSegmentationSelectValue(settings.value.pageSegmentationMode),
        set: (value: string) => {
            settings.value = {
                ...settings.value,
                pageSegmentationMode: resolveOcrPageSegmentationModeFromSelectValue(value),
            };
        },
    });

    function applyAgentOcrOptions(options: IAgentOcrRunOptions) {
        if (isRunSettingsLocked.value) {
            return;
        }

        settings.value = applyAgentOcrOptionsToSettings(
            settings.value,
            options,
            availableLanguageCodes.value,
        );
    }

    function createAgentOcrSnapshot() {
        const activeSettingsSnapshot = cloneOcrSettingsSnapshot(activeRunSettings.value);
        const draftSettingsSnapshot = cloneOcrSettingsSnapshot(settings.value);
        const completedSettingsSnapshot = cloneOcrSettingsSnapshot(lastCompletedRunSettings.value);

        return {
            isOpen: isOpen.value,
            isRunning: progress.value.isRunning,
            phase: progress.value.phase,
            phaseLabel: progressStatusText.value,
            currentPage: currentPage.value,
            totalPages: totalPages.value,
            processedCount: progress.value.processedCount,
            progressCurrentPage: progress.value.currentPage,
            progressTotalPages: progress.value.totalPages,
            draftSettings: draftSettingsSnapshot,
            activeRunSettings: activeSettingsSnapshot,
            lastCompletedRunSettings: completedSettingsSnapshot,
            selectedLanguages: [...settings.value.selectedLanguages],
            pageRange: settings.value.pageRange,
            customRange: settings.value.customRange,
            qualityProfile: settings.value.qualityProfile,
            preprocessingMode: settings.value.preprocessingMode,
            pageSegmentationMode: settings.value.pageSegmentationMode,
            hasWorkingCopy: Boolean(workingCopyPath.value),
            error: effectiveError.value,
            hasResults: hasResults.value,
        };
    }

    function scheduleCopyLogsStateReset() {
        stopCopyLogsStateReset();
        startCopyLogsStateReset();
    }

    function getExportLanguages() {
        return resolveOcrExportLanguages(
            lastCompletedRunSettings.value,
            activeRunSettings.value,
            settings.value,
        );
    }

    function buildOcrDiagnosticsLog(debugLogs: IDebugLogEntry[]) {
        return [
            'EVB Viewer OCR diagnostics',
            `generatedAt=${new Date().toISOString()}`,
            `currentPage=${currentPage.value}`,
            `totalPages=${totalPages.value}`,
            `isRunning=${progress.value.isRunning}`,
            `phase=${progress.value.phase}`,
            `phaseLabel=${progressStatusText.value}`,
            `draftSelectedLanguages=${formatLanguagesForDiagnostics(settings.value.selectedLanguages)}`,
            `activeRunSelectedLanguages=${formatLanguagesForDiagnostics(activeRunSettings.value?.selectedLanguages ?? [])}`,
            `lastCompletedSelectedLanguages=${formatLanguagesForDiagnostics(lastCompletedRunSettings.value?.selectedLanguages ?? [])}`,
            `draftPageRange=${settings.value.pageRange}`,
            `activeRunPageRange=${activeRunSettings.value?.pageRange ?? '-'}`,
            `lastCompletedPageRange=${lastCompletedRunSettings.value?.pageRange ?? '-'}`,
            `draftQualityProfile=${settings.value.qualityProfile}`,
            `activeRunQualityProfile=${activeRunSettings.value?.qualityProfile ?? '-'}`,
            `lastCompletedQualityProfile=${lastCompletedRunSettings.value?.qualityProfile ?? '-'}`,
            `draftPreprocessingMode=${settings.value.preprocessingMode}`,
            `activeRunPreprocessingMode=${activeRunSettings.value?.preprocessingMode ?? '-'}`,
            `lastCompletedPreprocessingMode=${lastCompletedRunSettings.value?.preprocessingMode ?? '-'}`,
            `draftPageSegmentationMode=${settings.value.pageSegmentationMode ?? '-'}`,
            `activeRunPageSegmentationMode=${activeRunSettings.value?.pageSegmentationMode ?? '-'}`,
            `lastCompletedPageSegmentationMode=${lastCompletedRunSettings.value?.pageSegmentationMode ?? '-'}`,
            `uiError=${effectiveError.value}`,
            '',
            '--- debug:log stream ---',
            ...(debugLogs.length > 0
                ? debugLogs.map(formatDebugLogEntry)
                : ['(no buffered logs available)']),
        ];
    }

    async function handleCopyLogs() {
        if (!effectiveError.value || isCopyingLogs.value) {
            return;
        }

        isCopyingLogs.value = true;
        copyLogsState.value = 'idle';

        try {
            const debugLogs = await getSettingsCapability().getDebugLogs();
            await copyClipboardText(buildOcrDiagnosticsLog(debugLogs).join('\n'));
            copyLogsState.value = 'copied';
        } catch (copyErr) {
            copyLogsState.value = 'failed';
            BrowserLogger.error('ocr', 'Failed to copy OCR debug logs', copyErr);
        } finally {
            isCopyingLogs.value = false;
            scheduleCopyLogsStateReset();
        }
    }

    function handleRunOcr() {
        if (!canRunOcr.value || !workingCopyPath.value) {
            return;
        }
        activeOcrSourcePath.value = workingCopyPath.value;
        activeOcrSourcePage.value = currentPage.value;
        void runOcr(currentPage.value, totalPages.value, workingCopyPath.value);
    }

    async function runOcrForAgent(options: IAgentOcrRunOptions = {}) {
        if (progress.value.isRunning) {
            return {
                ok: false,
                error: t('errors.ocr.alreadyRunning'),
                ocr: createAgentOcrSnapshot(),
            };
        }

        if (disabled.value) {
            return {
                ok: false,
                error: t('errors.ocr.disabled'),
                ocr: createAgentOcrSnapshot(),
            };
        }

        if (options.open !== false) {
            isOpen.value = true;
        }
        await loadLanguages();
        applyAgentOcrOptions(options);

        if (!pdfDocument.value || !workingCopyPath.value) {
            return {
                ok: false,
                error: t('errors.ocr.noDocument'),
                ocr: createAgentOcrSnapshot(),
            };
        }

        if (!hasSelectedAvailableLanguage.value) {
            return {
                ok: false,
                error: t('errors.ocr.noLanguages'),
                ocr: createAgentOcrSnapshot(),
            };
        }

        if (!canRunOcr.value) {
            return {
                ok: false,
                error: t('errors.ocr.start'),
                ocr: createAgentOcrSnapshot(),
            };
        }

        activeOcrSourcePath.value = workingCopyPath.value;
        activeOcrSourcePage.value = currentPage.value;
        await runOcr(currentPage.value, totalPages.value, workingCopyPath.value);
        await nextTick();

        const agentSnapshot = createAgentOcrSnapshot();
        if (hasResults.value) {
            return {
                ok: true,
                ...(effectiveError.value ? { warning: effectiveError.value } : {}),
                ocr: agentSnapshot,
            };
        }

        return {
            ok: false,
            error: effectiveError.value ?? t('errors.ocr.incomplete'),
            ocr: agentSnapshot,
        };
    }

    function handleCancel() {
        activeOcrSourcePath.value = null;
        activeOcrSourcePage.value = null;
        void cancelOcr();
    }

    async function cancelOcrForAgent() {
        activeOcrSourcePath.value = null;
        activeOcrSourcePage.value = null;
        const cancelResult = await cancelOcr();
        return {
            ok: cancelResult.canceled,
            cancel: cancelResult,
            ...(cancelResult.canceled ? {} : {error: cancelResult.error ?? t('errors.ocr.cancel')}),
            ocr: createAgentOcrSnapshot(),
        };
    }

    function handleExportDocx() {
        events.onExportDocx(getExportLanguages());
    }

    function handleCloseResults() {
        resetCompletedOcrState();
        isOpen.value = false;
    }

    function resetCompletedOcrState() {
        activeOcrSourcePath.value = null;
        activeOcrSourcePage.value = null;
        pendingAppliedOcrRequestId.value = null;
        clearResults();
        clearRunSettingsHistory();
    }

    watch(isOpen, (value) => {
        if (value) {
            void loadLanguages();
            return;
        }

        if (!progress.value.isRunning) {
            resetCompletedOcrState();
        }
    });

    watch(() => progress.value.isRunning, value => events.onRunningChange(value), {immediate: true});

    watch(() => settings.value.qualityProfile, (nextProfile, previousProfile) => {
        if (isRunSettingsLocked.value) {
            return;
        }

        const nextSettings = resolveQualityProfileSettings(
            settings.value,
            nextProfile,
            previousProfile,
        );
        if (nextSettings !== settings.value) {
            settings.value = nextSettings;
        }
    });

    watch(workingCopyPath, (nextPath, previousPath) => {
        if (nextPath === previousPath) {
            return;
        }
        if (progress.value.isRunning) {
            void cancelOcr();
        }
        resetCompletedOcrState();
    });

    watch(pdfDocument, (nextDocument, previousDocument) => {
        if (
            !nextDocument
            || nextDocument === previousDocument
            || pendingAppliedOcrRequestId.value === null
            || progress.value.isRunning
        ) {
            return;
        }

        resetCompletedOcrState();
    });

    watch(() => results.value.searchablePdfResult, (searchablePdfResult) => {
        const sourceWorkingCopyPath = activeOcrSourcePath.value;
        const sourcePageToRestore = activeOcrSourcePage.value ?? currentPage.value;
        if (searchablePdfResult && sourceWorkingCopyPath) {
            showSuccessState.value = true;
            stopSuccessStateReset();
            startSuccessStateReset();
            pendingAppliedOcrRequestId.value = searchablePdfResult.requestId;
            events.onOcrComplete({
                ...searchablePdfResult,
                sourceWorkingCopyPath,
                sourcePageToRestore,
            });
            activeOcrSourcePath.value = null;
            activeOcrSourcePage.value = null;
        }
    });

    onScopeDispose(() => {
        events.onRunningChange(false);
        stopCopyLogsStateReset();
        stopSuccessStateReset();
    });

    return {
        settings,
        progress,
        results,
        error,
        hasResults,
        progressPercent,
        latinCyrillicLanguages,
        greekLanguages,
        rtlLanguages,
        viewState,
        effectiveError,
        canRunOcr,
        showCustomRange,
        isCopyingLogs,
        copyLogsState,
        copyLogsTooltip,
        showSuccessState,
        progressStatusText,
        triggerTooltip,
        hasResultWarning,
        resultStatusText,
        selectedLanguagesModel,
        pageSegmentationModeSelectValue,
        handleCopyLogs,
        handleRunOcr,
        runOcrForAgent,
        handleCancel,
        cancelOcrForAgent,
        handleExportDocx,
        handleCloseResults,
        getAgentOcrSnapshot: createAgentOcrSnapshot,
    };
};
