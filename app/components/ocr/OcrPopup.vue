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
                <Icon v-if="!progress.isRunning && !showSuccessState" name="ph:text-aa" class="size-5" />
                <Icon v-else-if="!progress.isRunning" :name="triggerIcon" class="size-5" />
                <AppSpinner v-else size="md" tone="inherit" />
            </button>
        </AppTooltip>
        <span v-else class="hidden-trigger" aria-hidden="true" />

        <template #body>
            <div class="ocr-body flex flex-col gap-4">
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
                    <div class="custom-input-slot">
                        <UInput
                            v-show="settings.pageRange === 'custom'"
                            v-model="settings.customRange"
                            :placeholder="t('ocr.customRangePlaceholder')"
                            size="sm"
                            class="custom-input"
                        />
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
                            <span class="group-label">{{ t('ocr.latinCyrillic') }}</span>
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
                            <span class="group-label">{{ t('ocr.greek') }}</span>
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
                            <span class="group-label">{{ t('ocr.rtlScripts') }}</span>
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

                <!-- Progress Display -->
                <div class="status-slot">
                    <!-- Progress Display -->
                    <div
                        v-if="progress.isRunning"
                        class="progress flex flex-col gap-1.5"
                    >
                        <UProgress :value="progressPercent" />
                        <span class="progress-text">
                            <template v-if="progress.phase === 'preparing'">
                                {{ t('ocr.preparing') }}
                            </template>
                            <template v-else>
                                {{
                                    t('ocr.processingPage', {
                                        page: progress.currentPage,
                                        processed: progress.processedCount,
                                        total: progress.totalPages,
                                    })
                                }}
                            </template>
                        </span>
                    </div>

                    <!-- Error Display -->
                    <div
                        v-else-if="effectiveError"
                        class="error"
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

                    <!-- Results Summary -->
                    <div
                        v-else-if="hasResults"
                        class="results"
                    >
                        <UIcon name="i-ph-check-circle" class="size-4" />
                        <span>{{ t('ocr.complete') }}</span>
                    </div>
                </div>
            </div>
        </template>

        <template #footer>
            <AppTooltip :text="t('ocr.exportDocx')" :delay-duration="1200">
                <UButton
                    icon="i-ph-file-text"
                    variant="ghost"
                    color="neutral"
                    size="sm"
                    :loading="isExporting"
                    :disabled="isExporting || progress.isRunning || !workingCopyPath"
                    :aria-label="t('ocr.exportDocx')"
                    @click="handleExportDocx"
                />
            </AppTooltip>
            <AppTooltip
                v-if="!progress.isRunning"
                :text="t('ocr.start')"
                :delay-duration="1200"
            >
                <UButton
                    icon="i-ph-play"
                    color="primary"
                    size="sm"
                    :disabled="settings.selectedLanguages.length === 0"
                    :aria-label="t('ocr.start')"
                    @click="handleRunOcr"
                />
            </AppTooltip>
            <AppTooltip
                v-else
                :text="t('ocr.cancel')"
                :delay-duration="1200"
            >
                <UButton
                    icon="i-ph-x"
                    color="neutral"
                    variant="soft"
                    size="sm"
                    :aria-label="t('ocr.cancel')"
                    @click="handleCancel"
                />
            </AppTooltip>
        </template>
    </UModal>
</template>

<script setup lang="ts">
import {
    useClipboard,
    useTimeoutFn,
} from '@vueuse/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
    IDebugLogEntry,
    TDocumentRef,
} from '@contracts/platformApi';
import type { TTranslationKey } from '@i18n-app';
import AppSpinner from '@app/components/AppSpinner.vue';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getSettingsCapability } from '@app/utils/getSettingsCapability';
import type {
    IOcrSearchablePdfResult,
    TOcrPageRange,
} from '@app/utils/ocr/ocrTypes';

const { t } = useTypedI18n();
const { copy: copyClipboardText } = useClipboard();
type TOcrLanguageTranslationKey = Extract<TTranslationKey, `ocr.languageName.${string}`>;
type TAgentOcrRunOptions = {
    pageRange?: TOcrPageRange;
    customRange?: string;
    languages?: string[];
    open?: boolean;
};

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
    (e: 'update:open', value: boolean): void;
    (e: 'update:running', value: boolean): void;
    (e: 'ocrComplete', payload: IOcrSearchablePdfResult & {sourceWorkingCopyPath: TDocumentRef;}): void;
    (e: 'export-docx', selectedLanguages: string[]): void;
}>();

const {
    settings,
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
    toggleLanguage,
} = useOcr();

const isOpen = computed({
    get: () => open,
    set: (value: boolean) => emit('update:open', value),
});
const isExporting = computed(() => isExportingDocx ?? false);
const effectiveError = computed(() => error.value ?? externalError ?? null);
const isCopyingLogs = ref(false);
const copyLogsState = ref<'idle' | 'copied' | 'failed'>('idle');
const showSuccessState = ref(false);
const activeOcrSourcePath = ref<TDocumentRef | null>(null);
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

const triggerIcon = computed(() => showSuccessState.value ? 'ph:check-circle' : 'ph:text-aa');
const triggerTooltip = computed(() => {
    if (progress.value.isRunning) {
        return progress.value.phase === 'preparing'
            ? t('ocr.preparing')
            : t('ocr.processingPage', {
                page: progress.value.currentPage,
                processed: progress.value.processedCount,
                total: progress.value.totalPages,
            });
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
    const languages = value
        .filter((language): language is string => typeof language === 'string')
        .map(language => language.trim())
        .filter(Boolean);
    return languages.length > 0 ? Array.from(new Set(languages)) : null;
}

function applyAgentOcrOptions(options: TAgentOcrRunOptions) {
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

function createAgentOcrSnapshot() {
    return {
        isOpen: isOpen.value,
        isRunning: progress.value.isRunning,
        phase: progress.value.phase,
        currentPage,
        totalPages,
        processedCount: progress.value.processedCount,
        progressCurrentPage: progress.value.currentPage,
        progressTotalPages: progress.value.totalPages,
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

function getSelectedLanguagesForDiagnostics() {
    return settings.value.selectedLanguages.length > 0
        ? settings.value.selectedLanguages.join(',')
        : '-';
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
        `selectedLanguages=${getSelectedLanguagesForDiagnostics()}`,
        `isRunning=${progress.value.isRunning}`,
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
    void runOcr(currentPage, totalPages, workingCopyPath);
}

async function runOcrForAgent(options: TAgentOcrRunOptions = {}) {
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
    void runOcr(currentPage, totalPages, workingCopyPath);
    await nextTick();
    return {
        ok: effectiveError.value === null,
        ocr: createAgentOcrSnapshot(),
    };
}

function handleCancel() {
    activeOcrSourcePath.value = null;
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
    emit('export-docx', [...settings.value.selectedLanguages]);
}

watch(() => results.value.searchablePdfResult, (searchablePdfResult) => {
    const sourceWorkingCopyPath = activeOcrSourcePath.value;
    if (searchablePdfResult && sourceWorkingCopyPath) {
        isOpen.value = false;
        showSuccessState.value = true;
        stopSuccessStateReset();
        startSuccessStateReset();
        emit('ocrComplete', {
            ...searchablePdfResult,
            sourceWorkingCopyPath,
        });
        activeOcrSourcePath.value = null;
        clearResults();
    }
});

defineExpose({
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

.custom-input-slot {
    min-height: 2.5rem;
    padding-top: 0.5rem;
}

.custom-input {
    width: 100%;
}

.group-label {
    font-size: 0.625rem;
    color: var(--ui-text-dimmed);
    text-transform: uppercase;
    letter-spacing: 0.05em;
}

.checkboxes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.25rem 0.5rem;
    padding-left: 0.25rem;
}

.checkbox-item {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8125rem;
    cursor: pointer;
}

.checkbox-item input {
    accent-color: var(--ui-primary);
}

.progress-text {
    font-size: 0.75rem;
    color: var(--ui-text-muted);
    text-align: center;
}

.status-slot {
    min-height: 2.75rem;
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

.results {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--ui-success);
    font-size: 0.75rem;
}
</style>
