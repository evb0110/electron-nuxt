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
                    <div v-if="viewState === 'error'" class="error">
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
                    <div class="section">
                        <div class="label">{{ t('ocr.pages') }}</div>
                        <div class="flex flex-col gap-1.5">
                            <label class="radio-item">
                                <input
                                    v-model="settings.pageRange"
                                    type="radio"
                                    name="pageRange"
                                    value="all"
                                >
                                <span>{{ t('ocr.allPages', { total: totalPages }) }}</span>
                            </label>
                            <label class="radio-item">
                                <input
                                    v-model="settings.pageRange"
                                    type="radio"
                                    name="pageRange"
                                    value="current"
                                >
                                <span>{{ t('ocr.currentPage', { page: currentPage }) }}</span>
                            </label>
                            <label class="radio-item">
                                <input
                                    v-model="settings.pageRange"
                                    type="radio"
                                    name="pageRange"
                                    value="custom"
                                >
                                <span>{{ t('ocr.customRange') }}</span>
                            </label>
                        </div>
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
                                />
                            </div>
                        </div>
                    </div>

                    <!-- Language Selection -->
                    <div class="section">
                        <div class="label">{{ t('ocr.languages') }}</div>
                        <div class="flex flex-col gap-3">
                            <div
                                v-if="latinCyrillicLanguages.length > 0"
                                class="flex flex-col gap-1"
                            >
                                <div class="checkboxes">
                                    <label
                                        v-for="lang in latinCyrillicLanguages"
                                        :key="lang.code"
                                        class="checkbox-item"
                                    >
                                        <input
                                            type="checkbox"
                                            :checked="
                                                settings.selectedLanguages.includes(
                                                    lang.code,
                                                )
                                            "
                                            @change="
                                                toggleLanguage(
                                                    lang.code,
                                                    ($event.target as HTMLInputElement)
                                                        .checked,
                                                )
                                            "
                                        >
                                        <span>{{ translateLanguageName(lang.code) }}</span>
                                    </label>
                                </div>
                            </div>
                            <div
                                v-if="greekLanguages.length > 0"
                                class="flex flex-col gap-1"
                            >
                                <div class="checkboxes">
                                    <label
                                        v-for="lang in greekLanguages"
                                        :key="lang.code"
                                        class="checkbox-item"
                                    >
                                        <input
                                            type="checkbox"
                                            :checked="
                                                settings.selectedLanguages.includes(
                                                    lang.code,
                                                )
                                            "
                                            @change="
                                                toggleLanguage(
                                                    lang.code,
                                                    ($event.target as HTMLInputElement)
                                                        .checked,
                                                )
                                            "
                                        >
                                        <span>{{ translateLanguageName(lang.code) }}</span>
                                    </label>
                                </div>
                            </div>
                            <div
                                v-if="rtlLanguages.length > 0"
                                class="flex flex-col gap-1"
                            >
                                <div class="checkboxes">
                                    <label
                                        v-for="lang in rtlLanguages"
                                        :key="lang.code"
                                        class="checkbox-item"
                                    >
                                        <input
                                            type="checkbox"
                                            :checked="
                                                settings.selectedLanguages.includes(
                                                    lang.code,
                                                )
                                            "
                                            @change="
                                                toggleLanguage(
                                                    lang.code,
                                                    ($event.target as HTMLInputElement)
                                                        .checked,
                                                )
                                            "
                                        >
                                        <span>{{ translateLanguageName(lang.code) }}</span>
                                    </label>
                                </div>
                            </div>
                        </div>
                    </div>
                </template>

                <!-- RUNNING STATE -->
                <div
                    v-else-if="viewState === 'running'"
                    class="ocr-progress-panel flex flex-col gap-3"
                >
                    <AppProgressBar :value="progressPercent" />
                    <span class="progress-text">{{ progressStatusText }}</span>
                </div>

                <!-- RESULTS STATE -->
                <div
                    v-else
                    class="ocr-results-panel flex flex-col items-center gap-3"
                >
                    <UIcon name="i-ph-check-circle" class="results-icon size-8" />
                    <span class="results-text">{{ t('ocr.complete') }}</span>
                </div>
            </div>
        </template>

        <template #footer>
            <template v-if="viewState === 'running'">
                <UButton
                    color="neutral"
                    variant="soft"
                    size="sm"
                    icon="i-ph-x"
                    :label="t('ocr.cancel')"
                    @click="handleCancel"
                />
            </template>
            <template v-else-if="viewState === 'results'">
                <UButton
                    variant="ghost"
                    color="neutral"
                    size="sm"
                    icon="i-ph-file-text"
                    :label="t('ocr.exportDocx')"
                    :loading="isExporting"
                    :disabled="isExporting || !workingCopyPath"
                    @click="handleExportDocx"
                />
                <UButton
                    color="primary"
                    size="sm"
                    :label="t('common.close')"
                    @click="handleCloseResults"
                />
            </template>
            <template v-else>
                <UButton
                    variant="ghost"
                    color="neutral"
                    size="sm"
                    :label="t('common.cancel')"
                    @click="isOpen = false"
                />
                <UButton
                    color="primary"
                    size="sm"
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
import type { TOcrProgressPhase } from '@contracts/electronApiOcr';
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

const { t } = useTypedI18n();
const { copy: copyClipboardText } = useClipboard();
type TOcrLanguageTranslationKey = Extract<TTranslationKey, `ocr.languageName.${string}`>;

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
    externalError = undefined,
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
    toggleLanguage,
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
    if (effectiveError.value !== null) {
        return 'error';
    }
    if (hasResults.value) {
        return 'results';
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
    hasSelectedAvailableLanguage.value
    && Boolean(pdfDocument)
    && Boolean(workingCopyPath),
);

const showCustomRange = computed(() => settings.value.pageRange === 'custom');

const isCopyingLogs = ref(false);
const copyLogsState = ref<'idle' | 'copied' | 'failed'>('idle');
const showSuccessState = ref(false);
const activeOcrSourcePath = ref<TDocumentRef | null>(null);
const activeOcrSourcePage = ref<number | null>(null);
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

function getLanguageNameKey(code: string): TOcrLanguageTranslationKey {
    return `ocr.languageName.${code}` as TOcrLanguageTranslationKey;
}

function translateLanguageName(code: string) {
    return t(getLanguageNameKey(code), undefined);
}

function isOcrPageRange(value: unknown): value is TOcrPageRange {
    return value === 'all' || value === 'current' || value === 'custom';
}

function normalizeAgentLanguages(value: unknown) {
    if (!Array.isArray(value)) {
        return null;
    }
    const languages: string[] = [];
    for (const language of value) {
        if (typeof language !== 'string') {
            continue;
        }

        const trimmedLanguage = language.trim();
        if (trimmedLanguage) {
            languages.push(trimmedLanguage);
        }
    }
    return languages.length > 0 ? Array.from(new Set(languages)) : null;
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
    const languages = normalizeAgentLanguages(options.languages);
    if (languages) {
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
        hasWorkingCopy: Boolean(workingCopyPath),
        error: effectiveError.value,
        hasResults: hasResults.value,
    };
}

watch(isOpen, (value) => {
    if (value) {
        void loadLanguages();
    }
});

watch(() => progress.value.isRunning, value => emit('update:running', value), {immediate: true});

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
    const sourceSettings = lastCompletedRunSettings.value
        ?? activeRunSettings.value
        ?? settings.value;
    return [...sourceSettings.selectedLanguages];
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
    if (!pdfDocument || !workingCopyPath) {
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
            error: 'OCR is already running.',
            ocr: createAgentOcrSnapshot(),
        };
    }

    applyAgentOcrOptions(options);
    if (options.open !== false) {
        isOpen.value = true;
    }
    await loadLanguages();

    if (!pdfDocument || !workingCopyPath) {
        return {
            ok: false,
            error: 'No OCR-ready PDF document is available.',
            ocr: createAgentOcrSnapshot(),
        };
    }

    activeOcrSourcePath.value = workingCopyPath;
    activeOcrSourcePage.value = currentPage;
    void runOcr(currentPage, totalPages, workingCopyPath);
    await nextTick();
    return {
        ok: effectiveError.value === null,
        ocr: createAgentOcrSnapshot(),
    };
}

function handleCancel() {
    activeOcrSourcePath.value = null;
    activeOcrSourcePage.value = null;
    cancelOcr();
}

function cancelOcrForAgent() {
    handleCancel();
    return {
        ok: true,
        ocr: createAgentOcrSnapshot(),
    };
}

function handleExportDocx() {
    emit('export-docx', getExportLanguages());
}

function handleCloseResults() {
    clearResults();
    isOpen.value = false;
}

watch(() => workingCopyPath, () => {
    if (progress.value.isRunning) {
        return;
    }
    activeOcrSourcePath.value = null;
    activeOcrSourcePage.value = null;
    clearResults();
    clearRunSettingsHistory();
});

watch(() => results.value.searchablePdfResult, (searchablePdfResult) => {
    const sourceWorkingCopyPath = activeOcrSourcePath.value;
    const sourcePageToRestore = activeOcrSourcePage.value ?? currentPage;
    if (searchablePdfResult && sourceWorkingCopyPath) {
        showSuccessState.value = true;
        stopSuccessStateReset();
        startSuccessStateReset();
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
    width: var(--toolbar-control-height);
    height: var(--toolbar-control-height);
    overflow: hidden;
    visibility: hidden;
    pointer-events: none;
}

.ocr-trigger {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--toolbar-control-height);
    height: var(--toolbar-control-height);
    padding: 0.25rem;
    border: 1px solid transparent;
    border-radius: 0.4375rem;
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

.label {
    font-size: 0.6875rem;
    color: var(--ui-text-muted);
    margin-bottom: 0.5rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
}

.radio-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    cursor: pointer;
}

.radio-item input {
    accent-color: var(--ui-primary);
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

.checkboxes {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(12rem, 100%), 1fr));
    gap: var(--app-space-sm) var(--app-space-3xl);
    padding-left: var(--app-space-sm);
}

.checkbox-item {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
    font-size: 0.8125rem;
    cursor: pointer;
}

.checkbox-item span {
    min-width: 0;
    overflow-wrap: anywhere;
}

.checkbox-item input {
    accent-color: var(--ui-primary);
}

.ocr-progress-panel {
    padding: var(--app-space-9xl) 0;
}

.progress-text {
    font-size: 0.75rem;
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

.results-text {
    font-size: 0.875rem;
    color: var(--ui-text);
}

.error {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    color: var(--ui-error);
    font-size: 0.75rem;
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
