<template>
    <UModal
        v-model:open="isOpen"
        :title="t('ocr.runTitle')"
        :dismissible="!progress.isRunning"
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
                :disabled="disabled && !progress.isRunning"
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

                    <div class="section">
                        <URadioGroup
                            v-model="settings.supersessionPolicy"
                            name="ocrSupersessionPolicy"
                            :legend="t('ocr.supersession.label')"
                            :items="supersessionPolicyItems"
                            value-key="value"
                            :ui="listRadioGroupUi"
                        />
                        <div
                            v-if="settings.supersessionPolicy === 'replace-all'"
                            class="supersession-acknowledgement"
                        >
                            <UCheckbox
                                v-model="settings.replaceAllAcknowledged"
                                :label="t('ocr.supersession.replaceAllAcknowledgement')"
                            />
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
                        >
                            <template #legend>
                                {{ t('ocr.qualityProfile.label') }}
                                <OcrSettingHelpTooltip
                                    :trigger-label="t('ocr.settingHelpAria', { setting: t('ocr.qualityProfile.label') })"
                                    :options="qualityProfileHelpItems"
                                />
                            </template>
                        </URadioGroup>
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
                        >
                            <template #legend>
                                {{ t('ocr.preprocessing.label') }}
                                <OcrSettingHelpTooltip
                                    :trigger-label="t('ocr.settingHelpAria', { setting: t('ocr.preprocessing.label') })"
                                    :options="preprocessingModeHelpItems"
                                />
                            </template>
                        </URadioGroup>
                    </div>

                    <div class="section">
                        <UFormField
                            :label="t('ocr.pageSegmentation.label')"
                            :ui="formFieldUi"
                        >
                            <template #label>
                                {{ t('ocr.pageSegmentation.label') }}
                                <OcrSettingHelpTooltip
                                    :trigger-label="t('ocr.settingHelpAria', { setting: t('ocr.pageSegmentation.label') })"
                                    :options="pageSegmentationHelpItems"
                                />
                            </template>
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
                    v-else-if="viewState === 'running' || viewState === 'applying'"
                    class="ocr-progress-panel flex flex-col gap-3"
                    role="status"
                    aria-live="polite"
                >
                    <AppProgressBar :value="progressPercent" />
                    <span class="progress-text">{{ viewState === 'applying' ? applyingStatusText : progressStatusText }}</span>
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
            <template v-if="viewState === 'running' || viewState === 'applying'">
                <UButton
                    v-if="viewState === 'running'"
                    color="neutral"
                    variant="soft"
                    icon="i-ph-x"
                    :label="t('ocr.cancel')"
                    :disabled="progress.status === 'cancel-requested'"
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
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    TOcrPreprocessingMode,
    TOcrQualityProfile,
    TOcrTextSupersessionPolicy,
} from '@contracts/electronApiOcr';
import type { TTranslationKey } from '@i18n-app';
import AppProgressBar from '@app/components/AppProgressBar.vue';
import AppSpinner from '@app/components/AppSpinner.vue';
import OcrSettingHelpTooltip from '@app/modules/ocr-panel/components/OcrSettingHelpTooltip.vue';
import type { IOcrPopupAgentExpose } from '@app/types/ocrAgent';
import { OCR_PAGE_SEGMENTATION_AUTOMATIC_VALUE } from '@app/modules/ocr-panel/runtime/ocrPopupSettings';
import { useOcrPopupPresenter } from '@app/modules/ocr-panel/runtime/useOcrPopupPresenter';
import { getReaderCommandToolbarIcon } from '@app/utils/readerCommandIcons';
import type {
    IOcrSearchablePdfResult,
    TOcrPageRange,
} from '@app/utils/ocr/ocrTypes';

const { t } = useTypedI18n();
type TOcrLanguageTranslationKey = Extract<TTranslationKey, `ocr.languageName.${string}`>;
type TOcrLanguageModelStateKey = Extract<TTranslationKey, `ocr.languageModelState.${string}`>;
type TOcrQualityProfileLabelKey = Extract<TTranslationKey, `ocr.qualityProfile.options.${string}`>;
type TOcrPreprocessingModeLabelKey = Extract<TTranslationKey, `ocr.preprocessing.options.${string}`>;
type TOcrPageSegmentationLabelKey = Extract<TTranslationKey, `ocr.pageSegmentation.options.${string}`>;
type TOcrQualityProfileHelpKey = Extract<TTranslationKey, `ocr.qualityProfile.help.${string}`>;
type TOcrPreprocessingModeHelpKey = Extract<TTranslationKey, `ocr.preprocessing.help.${string}`>;
type TOcrPageSegmentationHelpKey = Extract<TTranslationKey, `ocr.pageSegmentation.help.${string}`>;
type TOcrSupersessionLabelKey = Extract<TTranslationKey, `ocr.supersession.options.${string}`>;
type TOcrSupersessionDescriptionKey = Extract<TTranslationKey, `ocr.supersession.descriptions.${string}`>;

const ocrQualityProfileOptions = [
    'balanced',
    'accurate',
    'poor-scan',
] as const satisfies readonly TOcrQualityProfile[];

const ocrPreprocessingModeOptions = [
    'off',
    'clean',
] as const satisfies readonly TOcrPreprocessingMode[];

const ocrSupersessionPolicies = [
    'missing-only',
    'replace-evb',
    'replace-all',
] as const satisfies readonly TOcrTextSupersessionPolicy[];

const ocrPageSegmentationOptions = [
    {
        value: '',
        labelKey: 'ocr.pageSegmentation.options.auto',
        helpKey: 'ocr.pageSegmentation.help.auto',
    },
    {
        value: '6',
        labelKey: 'ocr.pageSegmentation.options.singleBlock',
        helpKey: 'ocr.pageSegmentation.help.singleBlock',
    },
    {
        value: '11',
        labelKey: 'ocr.pageSegmentation.options.sparseText',
        helpKey: 'ocr.pageSegmentation.help.sparseText',
    },
] as const satisfies ReadonlyArray<{
    value: string;
    labelKey: TOcrPageSegmentationLabelKey;
    helpKey: TOcrPageSegmentationHelpKey;
}>;
const formFieldUi = { label: 'label ocr-setting-legend' } as const;
const listRadioGroupUi = {
    fieldset: 'gap-y-1.5',
    legend: 'label',
    item: 'items-center',
    label: 'font-normal',
} as const;
const segmentedRadioGroupUi = {
    fieldset: 'w-full gap-x-1',
    legend: 'label ocr-setting-legend',
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

const isOpen = computed({
    get: () => open,
    set: (value: boolean) => emit('update:open', value),
});
const isExporting = computed(() => isExportingDocx ?? false);
const {
    settings,
    progress,
    progressPercent,
    latinCyrillicLanguages,
    greekLanguages,
    rtlLanguages,
    viewState,
    effectiveError,
    canRunOcr,
    showCustomRange,
    isCopyingLogs,
    copyLogsTooltip,
    showSuccessState,
    progressStatusText,
    applyingStatusText,
    triggerTooltip,
    hasResultWarning,
    resultStatusText,
    selectedLanguagesModel,
    pageSegmentationModeSelectValue,
    handleCopyLogs,
    handleRunOcr,
    handleCancel,
    handleExportDocx,
    handleCloseResults,
    runOcrForAgent,
    cancelOcrForAgent,
    getAgentOcrSnapshot,
} = useOcrPopupPresenter({
    isOpen,
    context: {
        pdfDocument: () => pdfDocument,
        currentPage: () => currentPage,
        totalPages: () => totalPages,
        workingCopyPath: () => workingCopyPath,
        disabled: () => disabled,
        externalError: () => externalError,
    },
    events: {
        onRunningChange: value => emit('update:running', value),
        onOcrComplete: payload => emit('ocrComplete', payload),
        onExportDocx: selectedLanguages => emit('export-docx', selectedLanguages),
    },
});

const triggerIcon = computed(() => (
    showSuccessState.value ? 'ph:check-circle' : getReaderCommandToolbarIcon('ocr')
));
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
const supersessionPolicyItems = computed<Array<{
    value: TOcrTextSupersessionPolicy;
    label: string;
    description: string;
}>>(() => ocrSupersessionPolicies.map(policy => ({
    value: policy,
    label: t(getSupersessionLabelKey(policy), undefined),
    description: t(getSupersessionDescriptionKey(policy), undefined),
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
const qualityProfileHelpItems = computed(() => ocrQualityProfileOptions.map(profile => ({
    label: t(getQualityProfileLabelKey(profile), undefined),
    description: t(getQualityProfileHelpKey(profile), undefined),
})));
const preprocessingModeHelpItems = computed(() => ocrPreprocessingModeOptions.map(mode => ({
    label: t(getPreprocessingModeLabelKey(mode), undefined),
    description: t(getPreprocessingModeHelpKey(mode), undefined),
})));
const pageSegmentationHelpItems = computed(() => ocrPageSegmentationOptions.map(option => ({
    label: t(option.labelKey, undefined),
    description: t(option.helpKey, undefined),
})));
const latinCyrillicLanguageItems = computed(() => latinCyrillicLanguages.value.map(lang => ({
    value: lang.code,
    label: translateLanguageLabel(lang),
})));
const greekLanguageItems = computed(() => greekLanguages.value.map(lang => ({
    value: lang.code,
    label: translateLanguageLabel(lang),
})));
const rtlLanguageItems = computed(() => rtlLanguages.value.map(lang => ({
    value: lang.code,
    label: translateLanguageLabel(lang),
})));

function getLanguageNameKey(code: string): TOcrLanguageTranslationKey {
    return `ocr.languageName.${code}` as TOcrLanguageTranslationKey;
}

function translateLanguageName(code: string) {
    return t(getLanguageNameKey(code), undefined);
}

function translateLanguageLabel(language: {
    code: string;
    modelState?: 'installed' | 'downloading' | 'missing'
}) {
    const state = language.modelState ?? 'missing';
    const stateKey = `ocr.languageModelState.${state}` as TOcrLanguageModelStateKey;
    return `${translateLanguageName(language.code)} — ${t(stateKey, undefined)}`;
}

function getQualityProfileLabelKey(profile: TOcrQualityProfile): TOcrQualityProfileLabelKey {
    return `ocr.qualityProfile.options.${profile}`;
}

function getQualityProfileHelpKey(profile: TOcrQualityProfile): TOcrQualityProfileHelpKey {
    return `ocr.qualityProfile.help.${profile}`;
}

function getPreprocessingModeLabelKey(mode: TOcrPreprocessingMode): TOcrPreprocessingModeLabelKey {
    return `ocr.preprocessing.options.${mode}`;
}

function getPreprocessingModeHelpKey(mode: TOcrPreprocessingMode): TOcrPreprocessingModeHelpKey {
    return `ocr.preprocessing.help.${mode}`;
}

function getSupersessionLabelKey(policy: TOcrTextSupersessionPolicy): TOcrSupersessionLabelKey {
    return `ocr.supersession.options.${policy}`;
}

function getSupersessionDescriptionKey(policy: TOcrTextSupersessionPolicy): TOcrSupersessionDescriptionKey {
    return `ocr.supersession.descriptions.${policy}`;
}

defineExpose<IOcrPopupAgentExpose>({
    runOcrForAgent,
    cancelOcrForAgent,
    getAgentOcrSnapshot,
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
    z-index: var(--app-z-local-raised);
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

:deep(.ocr-setting-legend) {
    display: flex;
    align-items: center;
    gap: var(--app-space-sm);
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

.supersession-acknowledgement {
    margin-top: var(--app-space-3xl);
    padding: var(--app-space-lg);
    border: 1px solid var(--ui-warning);
    border-radius: var(--app-radius-md);
    background: color-mix(in srgb, var(--ui-warning) 8%, transparent);
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
