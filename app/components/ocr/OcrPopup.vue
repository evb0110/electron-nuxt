<template>
    <UPopover v-model:open="isOpen" mode="click" :disabled="disabled">
        <template v-if="!hideTrigger">
            <ToolbarButton
                :icon="triggerIcon"
                :tooltip="triggerTooltip"
                :active="isOpen || progress.isRunning"
                :disabled="disabled"
                :loading="progress.isRunning"
            />
        </template>
        <span v-else class="hidden-trigger" aria-hidden="true" />

        <template #content>
            <div class="ocr-popup">
                <div class="header">
                    <span class="title">{{ t('ocr.runTitle') }}</span>
                </div>

                <div class="divider" />

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
                    <UInput
                        v-if="settings.pageRange === 'custom'"
                        v-model="settings.customRange"
                        :placeholder="t('ocr.customRangePlaceholder')"
                        size="sm"
                        class="custom-input"
                    />
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
                <template v-if="progress.isRunning">
                    <div class="divider" />
                    <div class="progress flex flex-col gap-1.5">
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
                </template>

                <!-- Error Display -->
                <template v-if="effectiveError">
                    <div class="divider" />
                    <div class="error">
                        <UIcon name="i-lucide-alert-circle" class="size-4" />
                        <div class="error-content flex flex-1 flex-col gap-2">
                            <span class="error-text">{{ effectiveError }}</span>
                            <UTooltip :text="copyLogsTooltip" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-copy"
                                    variant="ghost"
                                    color="neutral"
                                    size="xs"
                                    class="copy-logs"
                                    :loading="isCopyingLogs"
                                    :aria-label="t('ocr.copyLogs')"
                                    @click="handleCopyLogs"
                                />
                            </UTooltip>
                        </div>
                    </div>
                </template>

                <!-- Results Summary -->
                <template v-if="hasResults && !progress.isRunning">
                    <div class="divider" />
                    <div class="results">
                        <UIcon name="i-lucide-check-circle" class="size-4" />
                        <span>{{ t('ocr.complete') }}</span>
                    </div>
                </template>

                <div class="divider" />

                <!-- Actions -->
                <div class="actions flex justify-end gap-2">
                    <UTooltip :text="t('ocr.exportDocx')" :delay-duration="1200">
                        <UButton
                            icon="i-lucide-file-text"
                            variant="ghost"
                            color="neutral"
                            size="sm"
                            :loading="isExporting"
                            :disabled="isExporting || progress.isRunning || !workingCopyPath"
                            :aria-label="t('ocr.exportDocx')"
                            @click="handleExportDocx"
                        />
                    </UTooltip>
                    <UTooltip
                        v-if="!progress.isRunning"
                        :text="t('ocr.start')"
                        :delay-duration="1200"
                    >
                        <UButton
                            icon="i-lucide-play"
                            color="primary"
                            size="sm"
                            :disabled="settings.selectedLanguages.length === 0"
                            :aria-label="t('ocr.start')"
                            @click="handleRunOcr"
                        />
                    </UTooltip>
                    <UTooltip
                        v-else
                        :text="t('ocr.cancel')"
                        :delay-duration="1200"
                    >
                        <UButton
                            icon="i-lucide-x"
                            color="neutral"
                            variant="soft"
                            size="sm"
                            :aria-label="t('ocr.cancel')"
                            @click="handleCancel"
                        />
                    </UTooltip>
                </div>
            </div>
        </template>
    </UPopover>
</template>

<script setup lang="ts">
import { useTimeoutFn } from '@vueuse/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TTranslationKey } from '@i18n-app';
import ToolbarButton from '@app/components/ToolbarButton.vue';
import { BrowserLogger } from '@app/utils/browser-logger';
import { getElectronAPI } from '@app/utils/platform';

const { t } = useTypedI18n();
type TOcrLanguageTranslationKey = Extract<TTranslationKey, `ocr.languageName.${string}`>;

interface IProps {
    pdfDocument: PDFDocumentProxy | null;
    currentPage: number;
    totalPages: number;
    workingCopyPath: string | null;
    open: boolean;
    isExportingDocx?: boolean;
    externalError?: string | null;
    disabled?: boolean;
    hideTrigger?: boolean;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:open', value: boolean): void;
    (e: 'ocrComplete', pdfData: Uint8Array): void;
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
    toggleLanguage,
} = useOcr();

const isOpen = computed({
    get: () => props.open,
    set: (value: boolean) => emit('update:open', value),
});
const isExporting = computed(() => props.isExportingDocx ?? false);
const effectiveError = computed(() => error.value ?? props.externalError ?? null);
const isCopyingLogs = ref(false);
const copyLogsState = ref<'idle' | 'copied' | 'failed'>('idle');
const showSuccessState = ref(false);
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

const triggerIcon = computed(() => showSuccessState.value ? 'lucide:check-circle' : 'lucide:scan-text');
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

watch(isOpen, (value) => {
    if (value) {
        void loadLanguages();
    }
});

onBeforeUnmount(() => {
    stopCopyLogsStateReset();
    stopSuccessStateReset();
});

function scheduleCopyLogsStateReset() {
    stopCopyLogsStateReset();
    startCopyLogsStateReset();
}

async function handleCopyLogs() {
    if (!effectiveError.value || isCopyingLogs.value) {
        return;
    }

    isCopyingLogs.value = true;
    copyLogsState.value = 'idle';

    try {
        const api = getElectronAPI();
        const debugLogs = await api.settings.getDebugLogs();
        const selectedLanguages = settings.value.selectedLanguages.length > 0
            ? settings.value.selectedLanguages.join(',')
            : '-';

        const lines = [
            'EVB Viewer OCR diagnostics',
            `generatedAt=${new Date().toISOString()}`,
            `currentPage=${props.currentPage}`,
            `totalPages=${props.totalPages}`,
            `selectedLanguages=${selectedLanguages}`,
            `isRunning=${progress.value.isRunning}`,
            `uiError=${effectiveError.value}`,
            '',
            '--- debug:log stream ---',
            ...(debugLogs.length > 0
                ? debugLogs.map(entry => `[${entry.timestamp}] [${entry.source}] ${entry.message}`)
                : ['(no buffered logs available)']),
        ];

        if (!globalThis.navigator?.clipboard || typeof globalThis.navigator.clipboard.writeText !== 'function') {
            throw new Error('Clipboard API is unavailable');
        }

        await globalThis.navigator.clipboard.writeText(lines.join('\n'));
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
    if (!props.pdfDocument || !props.workingCopyPath) {
        return;
    }
    void runOcr(props.currentPage, props.totalPages, props.workingCopyPath);
}

function handleCancel() {
    cancelOcr();
}

function handleExportDocx() {
    emit('export-docx', [...settings.value.selectedLanguages]);
}

// Emit when OCR completes with PDF data
watch(() => results.value.searchablePdfData, (pdfData) => {
    if (pdfData) {
        isOpen.value = false;
        showSuccessState.value = true;
        stopSuccessStateReset();
        startSuccessStateReset();
        emit('ocrComplete', pdfData);
    }
});
</script>

<style scoped>
.ocr-popup {
    padding: 0.25rem;
    min-width: 16rem;
    max-width: 20rem;
}

.hidden-trigger {
    display: block;
    width: 0;
    height: 0;
    overflow: hidden;
    pointer-events: none;
}

.header {
    padding: 0.5rem 0.75rem 0.25rem;
}

.title {
    font-weight: 600;
    font-size: 0.875rem;
}

.section {
    padding: 0.25rem 0.75rem;
}

.label {
    font-size: 0.6875rem;
    color: var(--ui-text-muted);
    margin-bottom: 0.5rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
}

.divider {
    height: 1px;
    background-color: var(--ui-border);
    margin: 0.25rem 0;
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

.custom-input {
    margin-top: 0.5rem;
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

.progress {
    padding: 0.5rem 0.75rem;
}

.progress-text {
    font-size: 0.75rem;
    color: var(--ui-text-muted);
    text-align: center;
}

.error {
    padding: 0.5rem 0.75rem;
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    color: var(--ui-error);
    font-size: 0.75rem;
}

.error-content {
    min-width: 0;
}

.error-text {
    overflow-wrap: anywhere;
}

.copy-logs {
    align-self: flex-start;
}

.results {
    padding: 0.5rem 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--ui-success);
    font-size: 0.75rem;
}

.actions {
    padding: 0.25rem 0.75rem 0.5rem;
}
</style>
