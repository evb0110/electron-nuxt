<template>
    <UModal
        v-model:open="isOpen"
        :title="t('ocr.runTitle')"
        :ui="{ content: 'sm:max-w-md', footer: 'justify-end gap-2' }"
    >
        <AppTooltip
            v-if="!hideTrigger"
            :text="triggerTooltip"
            :delay-duration="1200"
        >
            <button
                :class="[
                    'ocr-trigger',
                    {
                        'is-active': isOpen || progress.isRunning,
                        'is-loading': progress.isRunning,
                    },
                ]"
                :disabled="disabled || progress.isRunning"
                :aria-label="triggerTooltip"
                type="button"
            >
                <Icon
                    v-if="!progress.isRunning && !showSuccessState"
                    :name="getReaderCommandToolbarIcon('ocr')"
                    class="size-5"
                />
                <Icon v-else-if="!progress.isRunning" :name="triggerIcon" class="size-5" />
                <AppSpinner v-else size="md" tone="inherit" />
            </button>
        </AppTooltip>
        <span v-else class="hidden-trigger" aria-hidden="true" />

        <template #body>
            <div class="ocr-body flex flex-col gap-4">
                <!-- CONFIGURE / ERROR STATE (config stays editable so errors stay recoverable) -->
                <template v-if="viewState === 'configure' || viewState === 'error'">
                    <!-- Error banner -->
                    <div
                        v-if="viewState === 'error'"
                        class="error"
                        role="alert"
                        aria-live="assertive"
                    >
                        <UIcon name="i-ph-warning-circle" class="size-4" />
                        <div class="error-content flex flex-1 flex-col gap-2">
                            <span class="error-text">{{ effectiveError }}</span>
                            <AppTooltip :text="copyLogsTooltip" :delay-duration="1200">
                                <UButton
                                    icon="i-ph-copy"
                                    variant="ghost"
                                    color="neutral"
                                    size="xs"
                                    class="copy-logs"
                                    :loading="isCopyingLogs"
                                    :aria-label="t('ocr.copyLogs')"
                                    @click="handleCopyLogs"
                                />
                            </AppTooltip>
                        </div>
                    </div>

                    <!-- Page Range Selection -->
                    <div
                        class="section"
                    >
                        <URadioGroup
                            v-model="settings.pageRange"
                            name="pageRange"
                            :legend="t('ocr.pages')"
                            :items="pageRangeOptions"
                            value-key="value"
                            :ui="listRadioGroupUi"
                        />
                        <div
                            class="custom-range-reveal"
                            :class="{ 'is-open': showCustomRange }"
                        >
                            <div class="custom-range-reveal-inner">
                                <UInput
                                    v-model="settings.customRange"
                                    :placeholder="t('ocr.customRangePlaceholder')"
                                    size="sm"
                                    class="custom-input"
                                    :disabled="!showCustomRange"
                                    :tabindex="showCustomRange ? 0 : -1"
                                    :aria-hidden="!showCustomRange"
                                />
                            </div>
                        </div>
                    </div>

                    <!-- Quality Profile Selection -->
                    <div
                        class="section"
                    >
                        <URadioGroup
                            v-model="settings.qualityProfile"
                            name="ocrQualityProfile"
                            :legend="t('ocr.qualityProfile.label')"
                            :items="qualityProfileItems"
                            value-key="value"
                            variant="table"
                            orientation="horizontal"
                            indicator="hidden"
                            :ui="segmentedRadioGroupUi"
                        />
                    </div>

                    <!-- OCR tuning -->
                    <div
                        class="section"
                    >
                        <URadioGroup
                            v-model="settings.preprocessingMode"
                            name="ocrPreprocessingMode"
                            :legend="t('ocr.preprocessing.label')"
                            :items="preprocessingModeItems"
                            value-key="value"
                            variant="table"
                            orientation="horizontal"
                            indicator="hidden"
                            :ui="segmentedRadioGroupUi"
                        />
                    </div>

                    <div class="section">
                        <UFormField
                            :label="t('ocr.pageSegmentation.label')"
                            :ui="formFieldUi"
                        >
                            <USelect
                                id="ocr-page-segmentation-mode"
                                v-model="pageSegmentationModeSelectValue"
                                :items="pageSegmentationItems"
                                value-key="value"
                                class="w-full"
                                size="sm"
                            />
                        </UFormField>
                    </div>

                    <!-- Language Selection -->
                    <div
                        class="section"
                        role="group"
                        :aria-label="t('ocr.languages')"
                    >
                        <div class="label">{{ t('ocr.languages') }}</div>
                        <div class="flex flex-col gap-3">
                            <div
                                v-if="latinCyrillicLanguages.length > 0"
                                class="flex flex-col gap-1"
                            >
                                <UCheckboxGroup
                                    v-model="selectedLanguagesModel"
                                    :items="latinCyrillicLanguageItems"
                                    value-key="value"
                                    size="sm"
                                    :ui="languageCheckboxGroupUi"
                                />
                            </div>
                            <div
                                v-if="greekLanguages.length > 0"
                                class="flex flex-col gap-1"
                            >
                                <UCheckboxGroup
                                    v-model="selectedLanguagesModel"
                                    :items="greekLanguageItems"
                                    value-key="value"
                                    size="sm"
                                    :ui="languageCheckboxGroupUi"
                                />
                            </div>
                            <div
                                v-if="rtlLanguages.length > 0"
                                class="flex flex-col gap-1"
                            >
                                <UCheckboxGroup
                                    v-model="selectedLanguagesModel"
                                    :items="rtlLanguageItems"
                                    value-key="value"
                                    size="sm"
                                    :ui="languageCheckboxGroupUi"
                                />
                            </div>
                        </div>
                    </div>
                </template>

                <!-- RUNNING STATE -->
                <div
                    v-else-if="viewState === 'running'"
                    class="ocr-progress-panel flex flex-col gap-3"
                    role="status"
                    aria-live="polite"
                >
                    <AppProgressBar :value="progressPercent" />
                    <span class="progress-text">{{ progressStatusText }}</span>
                </div>

                <!-- RESULTS STATE -->
                <div
                    v-else
                    class="ocr-results-panel flex flex-col items-center gap-3"
                    role="status"
                    aria-live="polite"
                >
                    <UIcon
                        :name="hasResultWarning ? 'i-ph-warning-circle' : 'i-ph-check-circle'"
                        :class="[
                            'results-icon size-8',
                            { 'is-warning': hasResultWarning },
                        ]"
                    />
                    <span class="results-text">{{ resultStatusText }}</span>
                    <div
                        v-if="hasResultWarning"
                        class="results-warning"
                        role="alert"
                        aria-live="assertive"
                    >
                        <span class="results-warning-text">{{ effectiveError }}</span>
                        <AppTooltip :text="copyLogsTooltip" :delay-duration="1200">
                            <UButton
                                icon="i-ph-copy"
                                variant="ghost"
                                color="neutral"
                                size="xs"
                                class="copy-logs"
                                :loading="isCopyingLogs"
                                :aria-label="t('ocr.copyLogs')"
                                @click="handleCopyLogs"
                            />
                        </AppTooltip>
                    </div>
                </div>
            </div>
        </template>

        <template #footer>
            <template v-if="viewState === 'running'">
                <UButton
                    color="neutral"
                    variant="soft"
                    icon="i-ph-x"
                    :label="t('ocr.cancel')"
                    @click="handleCancel"
                />
            </template>
            <template v-else-if="viewState === 'results'">
                <UButton
                    variant="ghost"
                    color="neutral"
                    icon="i-ph-file-text"
                    :label="t('ocr.exportDocx')"
                    :loading="isExporting"
                    :disabled="isExporting || !workingCopyPath"
                    @click="handleExportDocx"
                />
                <UButton
                    color="primary"
                    :label="t('common.close')"
                    @click="handleCloseResults"
                />
            </template>
            <template v-else>
                <UButton
                    variant="ghost"
                    color="neutral"
                    :label="t('common.cancel')"
                    @click="isOpen = false"
                />
                <UButton
                    color="primary"
                    icon="i-ph-play"
                    :label="t('ocr.start')"
                    :disabled="!canRunOcr"
                    @click="handleRunOcr"
                />
            </template>
        </template>
    </UModal>
</template>

<script setup lang="ts">
import {
    useClipboard,
    useTimeoutFn,
} from '@vueuse/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IDebugLogEntry } from '@contracts/electronApiCommon';
import type {
    TOcrProgressPhase,
    TOcrPreprocessingMode,
    TOcrQualityProfile,
} from '@contracts/electronApiOcr';
import type { TTranslationKey } from '@i18n-app';
import AppProgressBar from '@app/components/AppProgressBar.vue';
import AppSpinner from '@app/components/AppSpinner.vue';
import type {
    IAgentOcrRunOptions,
    IOcrPopupAgentExpose,
} from '@app/types/ocrAgent';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getSettingsCapability } from '@app/utils/getSettingsCapability';
import { getReaderCommandToolbarIcon } from '@app/utils/readerCommandIcons';
import type {
    IOcrSettings,
    IOcrSearchablePdfResult,
    TOcrPageRange,
} from '@app/utils/ocr/ocrTypes';
import { resolveOcrExportLanguages } from '@app/utils/ocr/resolveOcrExportLanguages';

const { t } = useTypedI18n();
const { copy: copyClipboardText } = useClipboard();
type TOcrLanguageTranslationKey = Extract<TTranslationKey, `ocr.languageName.${string}`>;
type TOcrQualityProfileLabelKey = Extract<TTranslationKey, `ocr.qualityProfile.options.${string}`>;
type TOcrPreprocessingModeLabelKey = Extract<TTranslationKey, `ocr.preprocessing.options.${string}`>;
type TOcrPageSegmentationLabelKey = Extract<TTranslationKey, `ocr.pageSegmentation.options.${string}`>;

const ocrQualityProfileOptions = [
    'balanced',
    'accurate',
    'poor-scan',
] as const satisfies readonly TOcrQualityProfile[];

const ocrPreprocessingModeOptions = [
    'off',
    'clean',
] as const satisfies readonly TOcrPreprocessingMode[];

const ocrPageSegmentationOptions = [
    {
        value: '',
        labelKey: 'ocr.pageSegmentation.options.auto',
    },
    {
        value: '3',
        labelKey: 'ocr.pageSegmentation.options.autoPage',
    },
    {
        value: '6',
        labelKey: 'ocr.pageSegmentation.options.singleBlock',
    },
    {
        value: '11',
        labelKey: 'ocr.pageSegmentation.options.sparseText',
    },
] as const satisfies ReadonlyArray<{
    value: string;
    labelKey: TOcrPageSegmentationLabelKey;
}>;
const OCR_PAGE_SEGMENTATION_AUTOMATIC_VALUE = '__automatic_page_segmentation__';

const formFieldUi = { label: 'label' } as const;
const listRadioGroupUi = {
    fieldset: 'gap-y-1.5',
    legend: 'label',
    item: 'items-center',
    label: 'font-normal',
} as const;
const segmentedRadioGroupUi = {
    fieldset: 'w-full gap-x-1',
    legend: 'label',
    item: 'flex-1 cursor-pointer justify-center px-2 py-1.5',
    label: 'w-full truncate text-center text-xs font-medium',
} as const;
const languageCheckboxGroupUi = {
    fieldset: 'language-checkboxes',
    item: 'min-w-0',
    label: 'min-w-0 font-normal',
} as const;

interface IProps {
    pdfDocument: PDFDocumentProxy | null;
    currentPage: number;
    totalPages: number;
    workingCopyPath: TDocumentRef | null;
    open: boolean;
    isExportingDocx?: boolean;
    externalError?: string | null;
    disabled?: boolean;
    hideTrigger?: boolean;
}

const {
    currentPage,
    disabled = false,
    externalError = undefined,
    hideTrigger = false,
    isExportingDocx,
    open,
    pdfDocument,
    totalPages,
    workingCopyPath,
} = defineProps<IProps>();

const emit = defineEmits<{
    'update:open': [value: boolean];
    'update:running': [value: boolean];
    ocrComplete: [payload: IOcrSearchablePdfResult & {
        sourceWorkingCopyPath: TDocumentRef;
        sourcePageToRestore: number;
    }];
    'export-docx': [selectedLanguages: string[]];
}>();

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

type TOcrViewState = 'configure' | 'running' | 'results' | 'error';

const isOpen = computed({
    get: () => open,
    set: (value: boolean) => emit('update:open', value),
});
const isExporting = computed(() => isExportingDocx ?? false);
const effectiveError = computed(() => error.value ?? externalError ?? null);
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
    !disabled
    && !progress.value.isRunning
    && hasSelectedAvailableLanguage.value
    && Boolean(pdfDocument)
    && Boolean(workingCopyPath),
);

const showCustomRange = computed(() => settings.value.pageRange === 'custom');

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

const triggerIcon = computed(() => (
    showSuccessState.value ? 'ph:check-circle' : getReaderCommandToolbarIcon('ocr')
));
const ocrProgressStageKeys = {
    preparing: 'ocr.preparing',
    'model-prep': 'ocr.progressStage.modelPrep',
    'pdf-prep': 'ocr.progressStage.pdfPrep',
    'dpi-inspection': 'ocr.progressStage.dpiInspection',
    'page-size-probing': 'ocr.progressStage.pageSizeProbing',
    merging: 'ocr.progressStage.merging',
    indexing: 'ocr.progressStage.indexing',
} as const satisfies Record<Exclude<TOcrProgressPhase, 'processing'>, TTranslationKey>;
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
            selectedLanguages: Array.from(new Set(selectedLanguages)),
        };
    },
});
const pageRangeOptions = computed<Array<{
    value: TOcrPageRange;
    label: string;
}>>(() => [
    {
        value: 'all',
        label: t('ocr.allPages', { total: totalPages }),
    },
    {
        value: 'current',
        label: t('ocr.currentPage', { page: currentPage }),
    },
    {
        value: 'custom',
        label: t('ocr.customRange'),
    },
]);
const qualityProfileItems = computed<Array<{
    value: TOcrQualityProfile;
    label: string;
}>>(() => ocrQualityProfileOptions.map(profile => ({
    value: profile,
    label: t(getQualityProfileLabelKey(profile), undefined),
})));
const preprocessingModeItems = computed<Array<{
    value: TOcrPreprocessingMode;
    label: string;
}>>(() => ocrPreprocessingModeOptions.map(mode => ({
    value: mode,
    label: t(getPreprocessingModeLabelKey(mode), undefined),
})));
const pageSegmentationItems = computed<Array<{
    value: string;
    label: string;
}>>(() => ocrPageSegmentationOptions.map(option => ({
    value: option.value === ''
        ? OCR_PAGE_SEGMENTATION_AUTOMATIC_VALUE
        : option.value,
    label: t(option.labelKey, undefined),
})));
const latinCyrillicLanguageItems = computed(() => latinCyrillicLanguages.value.map(lang => ({
    value: lang.code,
    label: translateLanguageName(lang.code),
})));
const greekLanguageItems = computed(() => greekLanguages.value.map(lang => ({
    value: lang.code,
    label: translateLanguageName(lang.code),
})));
const rtlLanguageItems = computed(() => rtlLanguages.value.map(lang => ({
    value: lang.code,
    label: translateLanguageName(lang.code),
})));

const pageSegmentationModeSelectValue = computed({
    get: () => settings.value.pageSegmentationMode === null
        ? OCR_PAGE_SEGMENTATION_AUTOMATIC_VALUE
        : String(settings.value.pageSegmentationMode),
    set: (value: string) => {
        const pageSegmentationMode = value === OCR_PAGE_SEGMENTATION_AUTOMATIC_VALUE ? null : Number(value);
        settings.value = {
            ...settings.value,
            pageSegmentationMode: isOcrPageSegmentationMode(pageSegmentationMode)
                ? pageSegmentationMode
                : null,
        };
    },
});

function getLanguageNameKey(code: string): TOcrLanguageTranslationKey {
    return `ocr.languageName.${code}` as TOcrLanguageTranslationKey;
}

function translateLanguageName(code: string) {
    return t(getLanguageNameKey(code), undefined);
}

function isOcrPageRange(value: unknown): value is TOcrPageRange {
    return value === 'all' || value === 'current' || value === 'custom';
}

function isOcrQualityProfile(value: unknown): value is TOcrQualityProfile {
    return value === 'balanced' || value === 'accurate' || value === 'poor-scan';
}

function isOcrPreprocessingMode(value: unknown): value is TOcrPreprocessingMode {
    return value === 'off' || value === 'clean';
}

function isOcrPageSegmentationMode(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 13;
}

function getQualityProfileLabelKey(profile: TOcrQualityProfile): TOcrQualityProfileLabelKey {
    return `ocr.qualityProfile.options.${profile}`;
}

function getPreprocessingModeLabelKey(mode: TOcrPreprocessingMode): TOcrPreprocessingModeLabelKey {
    return `ocr.preprocessing.options.${mode}`;
}

function normalizeAgentLanguages(value: unknown) {
    if (!Array.isArray(value)) {
        return null;
    }
    const availableCodes = availableLanguageCodes.value;
    const languages: string[] = [];
    for (const language of value) {
        if (typeof language !== 'string') {
            continue;
        }

        const trimmedLanguage = language.trim();
        if (trimmedLanguage && availableCodes.has(trimmedLanguage)) {
            languages.push(trimmedLanguage);
        }
    }
    return Array.from(new Set(languages));
}

function applyAgentOcrOptions(options: IAgentOcrRunOptions) {
    if (isRunSettingsLocked.value) {
        return;
    }

    const nextSettings = {...settings.value};
    if (isOcrPageRange(options.pageRange)) {
        nextSettings.pageRange = options.pageRange;
    }
    if (typeof options.customRange === 'string') {
        nextSettings.customRange = options.customRange;
    }
    if (isOcrQualityProfile(options.qualityProfile)) {
        nextSettings.qualityProfile = options.qualityProfile;
    }
    if (isOcrPreprocessingMode(options.preprocessingMode)) {
        nextSettings.preprocessingMode = options.preprocessingMode;
    }
    if (isOcrPageSegmentationMode(options.pageSegmentationMode)) {
        nextSettings.pageSegmentationMode = options.pageSegmentationMode;
    }
    const languages = normalizeAgentLanguages(options.languages);
    if (languages !== null) {
        nextSettings.selectedLanguages = languages;
    }
    settings.value = nextSettings;
}

function cloneSettingsSnapshot(value: IOcrSettings | null) {
    return value
        ? {
            pageRange: value.pageRange,
            customRange: value.customRange,
            selectedLanguages: [...value.selectedLanguages],
            qualityProfile: value.qualityProfile,
            preprocessingMode: value.preprocessingMode,
            pageSegmentationMode: value.pageSegmentationMode,
        }
        : null;
}

function createAgentOcrSnapshot() {
    const activeSettingsSnapshot = cloneSettingsSnapshot(activeRunSettings.value);
    const draftSettingsSnapshot = cloneSettingsSnapshot(settings.value);
    const completedSettingsSnapshot = cloneSettingsSnapshot(lastCompletedRunSettings.value);

    return {
        isOpen: isOpen.value,
        isRunning: progress.value.isRunning,
        phase: progress.value.phase,
        phaseLabel: progressStatusText.value,
        currentPage,
        totalPages,
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
        hasWorkingCopy: Boolean(workingCopyPath),
        error: effectiveError.value,
        hasResults: hasResults.value,
    };
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

watch(() => progress.value.isRunning, value => emit('update:running', value), {immediate: true});

watch(() => settings.value.qualityProfile, (nextProfile, previousProfile) => {
    if (isRunSettingsLocked.value) {
        return;
    }

    if (nextProfile === 'poor-scan' && settings.value.preprocessingMode === 'off') {
        settings.value = {
            ...settings.value,
            preprocessingMode: 'clean',
        };
        return;
    }

    if (
        previousProfile === 'poor-scan'
        && nextProfile !== 'poor-scan'
        && settings.value.preprocessingMode === 'clean'
    ) {
        settings.value = {
            ...settings.value,
            preprocessingMode: 'off',
        };
    }
});

onBeforeUnmount(() => {
    emit('update:running', false);
    stopCopyLogsStateReset();
    stopSuccessStateReset();
});

function scheduleCopyLogsStateReset() {
    stopCopyLogsStateReset();
    startCopyLogsStateReset();
}

function formatLanguagesForDiagnostics(languages: readonly string[]) {
    return languages.length > 0
        ? languages.join(',')
        : '-';
}

function getExportLanguages() {
    return resolveOcrExportLanguages(
        lastCompletedRunSettings.value,
        activeRunSettings.value,
        settings.value,
    );
}

function formatDebugLogEntry(entry: IDebugLogEntry) {
    return `[${entry.timestamp}] [${entry.source}] ${entry.message}`;
}

function buildOcrDiagnosticsLog(debugLogs: IDebugLogEntry[]) {
    return [
        'EVB Viewer OCR diagnostics',
        `generatedAt=${new Date().toISOString()}`,
        `currentPage=${currentPage}`,
        `totalPages=${totalPages}`,
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
    if (!canRunOcr.value || !workingCopyPath) {
        return;
    }
    activeOcrSourcePath.value = workingCopyPath;
    activeOcrSourcePage.value = currentPage;
    void runOcr(currentPage, totalPages, workingCopyPath);
}

async function runOcrForAgent(options: IAgentOcrRunOptions = {}) {
    if (progress.value.isRunning) {
        return {
            ok: false,
            error: t('errors.ocr.alreadyRunning'),
            ocr: createAgentOcrSnapshot(),
        };
    }

    if (disabled) {
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

    if (!pdfDocument || !workingCopyPath) {
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

    activeOcrSourcePath.value = workingCopyPath;
    activeOcrSourcePage.value = currentPage;
    await runOcr(currentPage, totalPages, workingCopyPath);
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
    emit('export-docx', getExportLanguages());
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

watch(() => workingCopyPath, (nextPath, previousPath) => {
    if (nextPath === previousPath) {
        return;
    }
    if (progress.value.isRunning) {
        void cancelOcr();
    }
    resetCompletedOcrState();
});

watch(() => pdfDocument, (nextDocument, previousDocument) => {
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
    const sourcePageToRestore = activeOcrSourcePage.value ?? currentPage;
    if (searchablePdfResult && sourceWorkingCopyPath) {
        showSuccessState.value = true;
        stopSuccessStateReset();
        startSuccessStateReset();
        pendingAppliedOcrRequestId.value = searchablePdfResult.requestId;
        emit('ocrComplete', {
            ...searchablePdfResult,
            sourceWorkingCopyPath,
            sourcePageToRestore,
        });
        activeOcrSourcePath.value = null;
        activeOcrSourcePage.value = null;
    }
});

defineExpose<IOcrPopupAgentExpose>({
    runOcrForAgent,
    cancelOcrForAgent,
    getAgentOcrSnapshot: createAgentOcrSnapshot,
});
</script>

<style scoped>
.hidden-trigger {
    display: block;
    width: var(--toolbar-control-height, var(--app-toolbar-control-size));
    height: var(--toolbar-control-height, var(--app-toolbar-control-size));
    overflow: hidden;
    visibility: hidden;
    pointer-events: none;
}

.ocr-trigger {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--toolbar-control-height, var(--app-toolbar-control-size));
    height: var(--toolbar-control-height, var(--app-toolbar-control-size));
    padding: var(--app-toolbar-button-padding);
    border: 1px solid transparent;
    border-radius: var(--app-toolbar-control-radius);
    background: transparent;
    color: var(--app-toolbar-control-inactive-fg);
    cursor: pointer;
    transition: background-color 0.1s ease, border-color 0.1s ease, color 0.1s ease, opacity 0.1s ease;
}

.ocr-trigger:hover {
    background: var(--app-toolbar-control-hover-bg);
    border-color: var(--app-toolbar-control-hover-border);
    color: var(--app-toolbar-control-hover-fg);
}

.ocr-trigger.is-active {
    background: var(--app-toolbar-control-active-bg);
    border-color: var(--app-toolbar-control-active-border);
    color: var(--app-toolbar-control-hover-fg);
}

.ocr-trigger.is-active:hover {
    background: var(--app-toolbar-control-active-hover-bg);
    border-color: var(--app-toolbar-control-active-hover-border);
}

.ocr-trigger:focus {
    outline: none;
}

.ocr-trigger:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
    position: relative;
    z-index: 1;
}

.ocr-trigger:disabled {
    opacity: var(--app-toolbar-control-disabled-opacity);
    color: var(--app-toolbar-control-disabled-fg);
}

.ocr-trigger:disabled:hover {
    background: transparent;
    border-color: transparent;
    color: var(--app-toolbar-control-disabled-fg);
}

.ocr-trigger:disabled.is-loading {
    opacity: 1;
    color: var(--ui-text-muted);
    cursor: wait;
}

.label,
:deep(.label) {
    font-size: var(--app-text-size-micro);
    color: var(--ui-text-muted);
    margin-bottom: var(--app-space-3xl);
    text-transform: uppercase;
    letter-spacing: 0.05em;
}

.custom-range-reveal {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.18s ease;
}

.custom-range-reveal.is-open {
    grid-template-rows: 1fr;
    padding-top: var(--app-space-3xl);
}

.custom-range-reveal-inner {
    overflow: hidden;
    min-height: 0;
}

.custom-input {
    width: 100%;
}

:deep(.language-checkboxes) {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(12rem, 100%), 1fr));
    gap: var(--app-space-sm) var(--app-space-3xl);
    padding-left: var(--app-space-sm);
}

:deep(.language-checkboxes [data-slot="label"]) {
    overflow-wrap: anywhere;
}

.ocr-progress-panel {
    padding: var(--app-space-9xl) 0;
}

.progress-text {
    font-size: var(--app-text-size-kicker);
    color: var(--ui-text-muted);
    text-align: center;
}

.ocr-results-panel {
    padding: var(--app-space-9xl) 0;
    text-align: center;
}

.results-icon {
    color: var(--ui-success);
}

.results-icon.is-warning {
    color: var(--ui-warning);
}

.results-text {
    font-size: var(--app-text-size-body);
    color: var(--ui-text);
}

.results-warning {
    display: flex;
    align-items: flex-start;
    gap: var(--app-space-sm);
    color: var(--ui-warning);
    font-size: var(--app-text-size-kicker);
    text-align: left;
}

.results-warning-text {
    overflow-wrap: anywhere;
}

.error {
    display: flex;
    align-items: flex-start;
    gap: var(--app-space-3xl);
    color: var(--ui-error);
    font-size: var(--app-text-size-kicker);
}

.error-content {
    min-width: 0;
    align-items: flex-start;
}

.error-text {
    align-self: stretch;
    overflow-wrap: anywhere;
}

.copy-logs {
    align-self: flex-start;
    width: auto;
    flex: none;
}
</style>
