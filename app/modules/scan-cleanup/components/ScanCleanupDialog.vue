<template>
    <UModal
        v-model:open="isOpen"
        :title="t('scanCleanup.title')"
        dismissible
        :ui="{
            content: 'scan-cleanup-dialog-shell w-[var(--app-scan-dialog-width)] sm:max-w-[var(--app-scan-dialog-max-width)] h-[var(--app-scan-dialog-height)] max-h-[var(--app-scan-dialog-height)] flex flex-col',
            body: 'scan-cleanup-dialog-body flex-1 min-h-0 flex flex-col overflow-hidden p-0',
            footer: 'scan-cleanup-dialog-footer',
        }"
    >
        <template #description>
            <span class="sr-only">{{ t('scanCleanup.description') }}</span>
        </template>

        <AppTooltip :text="triggerTooltip" :delay-duration="1200">
            <span v-if="!hideTrigger" class="scan-cleanup-trigger-wrap">
                <UButton
                    class="scan-cleanup-trigger"
                    :class="{'is-active': isOpen || isRunning}"
                    :disabled="disabled || !sourcePath"
                    color="neutral"
                    variant="ghost"
                    size="md"
                    square
                    :aria-label="triggerTooltip"
                    :aria-pressed="isOpen || isRunning"
                    type="button"
                >
                    <ScanCleanupScissorsIcon class="size-5" />
                </UButton>
                <span v-if="isRunning" class="scan-cleanup-running-dot" aria-hidden="true" />
            </span>
            <span v-else class="hidden-trigger" aria-hidden="true" />
        </AppTooltip>

        <template #body>
            <div
                class="scan-cleanup-workspace"
                :class="{'is-page-list-collapsed': pageListCollapsed}"
                :aria-busy="isRunning"
            >
                <fieldset class="scan-cleanup-options-rail app-scrollbar app-scroll-region--balanced" :disabled="isRunning">
                    <div v-if="inlineError" class="scan-cleanup-error" role="alert">{{ inlineError }}</div>

                    <section class="scan-cleanup-option-group">
                        <h3>{{ t('scanCleanup.groups.layout') }}</h3>
                        <UFormField :label="t('scanCleanup.layout.label')">
                            <USelect v-model="settings.layoutMode" :items="layoutItems" value-key="value" class="w-full" />
                        </UFormField>
                        <UFormField :label="t('scanCleanup.layout.readingOrder')">
                            <USelect v-model="settings.readingOrder" :items="readingOrderItems" value-key="value" class="w-full" />
                        </UFormField>
                    </section>

                    <section class="scan-cleanup-option-group">
                        <h3>{{ t('scanCleanup.groups.output') }}</h3>
                        <div class="scan-cleanup-segmented" role="radiogroup" :aria-label="t('scanCleanup.output.label')">
                            <UButton
                                v-for="item in outputItems"
                                :key="item.value"
                                type="button"
                                :color="settings.outputMode === item.value ? 'primary' : 'neutral'"
                                :variant="settings.outputMode === item.value ? 'soft' : 'outline'"
                                :aria-checked="settings.outputMode === item.value"
                                role="radio"
                                :label="item.label"
                                @click="settings.outputMode = item.value"
                            />
                        </div>
                        <UFormField
                            v-if="settings.outputMode === 'bw'"
                            :label="t('scanCleanup.thickness.label', {value: thicknessLabel})"
                        >
                            <USlider
                                color="primary"
                                :min="-5"
                                :max="5"
                                :step="1"
                                :model-value="settings.thickness"
                                :aria-label="t('scanCleanup.thickness.control')"
                                @update:model-value="handleThicknessInput"
                            />
                            <div class="scan-cleanup-scale" aria-hidden="true">
                                <span>{{ t('scanCleanup.thickness.thinner') }}</span>
                                <span>{{ t('scanCleanup.thickness.default') }}</span>
                                <span>{{ t('scanCleanup.thickness.thicker') }}</span>
                            </div>
                        </UFormField>
                        <UCheckbox
                            v-if="settings.outputMode === 'bw'"
                            v-model="settings.despeckle"
                            :label="t('scanCleanup.despeckle')"
                        />
                    </section>

                    <section class="scan-cleanup-option-group">
                        <h3>{{ t('scanCleanup.groups.cropSize') }}</h3>
                        <UCheckbox v-model="settings.crop" :label="t('scanCleanup.crop.label')" />
                        <UFormField v-if="settings.crop" :label="t('scanCleanup.crop.margins')">
                            <UInput v-model.number="settings.marginsMm" type="number" :min="0" :max="25" :step="1" />
                        </UFormField>
                        <UCheckbox v-model="settings.matchPageSize" :label="t('scanCleanup.pageSize.match')" />
                        <UCheckbox v-model="settings.skipBlankPages" :label="t('scanCleanup.crop.skipBlank')" />
                        <UFormField v-if="settings.matchPageSize" :label="t('scanCleanup.pageSize.alignment')">
                            <div class="scan-cleanup-alignment-grid" role="radiogroup" :aria-label="t('scanCleanup.pageSize.alignment')">
                                <UButton
                                    v-for="item in alignmentItems"
                                    :key="item.value"
                                    :aria-label="item.label"
                                    :aria-checked="settings.pageAlignment === item.value"
                                    :color="settings.pageAlignment === item.value ? 'primary' : 'neutral'"
                                    :variant="settings.pageAlignment === item.value ? 'soft' : 'outline'"
                                    role="radio"
                                    size="sm"
                                    :icon="item.icon"
                                    @click="settings.pageAlignment = item.value"
                                />
                            </div>
                        </UFormField>
                    </section>

                    <div class="scan-cleanup-footnote">
                        <span>{{ t('scanCleanup.imageOnly') }}</span>
                        <UPopover>
                            <UButton
                                type="button"
                                color="neutral"
                                variant="link"
                                size="xs"
                                :label="t('scanCleanup.details')"
                            />
                            <template #content>
                                <div class="scan-cleanup-details-popover">
                                    <p>{{ t('scanCleanup.rasterNotice') }}</p>
                                    <p>{{ t('scanCleanup.lossNotice') }}</p>
                                </div>
                            </template>
                        </UPopover>
                    </div>
                </fieldset>

                <ScanCleanupPageList
                    v-model:page-number="previewPage"
                    v-model:collapsed="pageListCollapsed"
                    :total-pages="previewTotalPages"
                    :overrides="settings.pageOverrides"
                    :classifications="previewClassifications"
                    :disabled="isRunning"
                    @update:override="updatePageOverride"
                    @reset="resetPageOverrides"
                />

                <div class="scan-cleanup-preview-hero">
                    <ScanCleanupPreviewPane
                        :result="previewResult"
                        :loading="previewLoading"
                        :error="previewError"
                        :view-mode="previewViewMode"
                        :zoom-mode="previewZoomMode"
                        :match-page-size="settings.matchPageSize"
                        :alignment="settings.pageAlignment"
                        :page-number="previewPage"
                        :total-pages="previewTotalPages"
                        :manual-split-x="currentPageOverride.manualSplitX"
                        :reading-order="settings.readingOrder"
                        @previous="navigatePreview(-1)"
                        @next="navigatePreview(1)"
                        @update:view-mode="previewViewMode = $event"
                        @update:zoom-mode="previewZoomMode = $event"
                        @update:manual-split-x="updateCurrentManualSplit"
                    />
                    <div v-if="isRunning" class="scan-cleanup-progress-overlay" role="status" aria-live="polite">
                        <div class="scan-cleanup-progress-card">
                            <AppProgressBar :value="jobProgress.percent" />
                            <strong>{{ progressText }}</strong>
                            <span>{{ t('scanCleanup.continuesHint') }}</span>
                        </div>
                    </div>
                </div>
            </div>
        </template>

        <template #footer>
            <div class="scan-cleanup-footer-info">
                <div class="scan-cleanup-estimate">{{ isRunning ? '' : outputEstimate }}</div>
                <UCheckbox
                    v-if="!isRunning"
                    v-model="runOcrAfterCleanup"
                    :label="t('scanCleanup.runOcrAfterCleanup')"
                />
            </div>
            <div class="scan-cleanup-footer-actions">
                <UButton
                    v-if="isRunning"
                    color="neutral"
                    variant="outline"
                    :label="cancelRequested ? t('scanCleanup.canceling') : t('scanCleanup.cancel')"
                    :disabled="cancelRequested"
                    @click="cancel"
                />
                <template v-else>
                    <UButton color="neutral" variant="outline" :label="t('common.cancel')" @click="isOpen = false" />
                    <UButton
                        color="primary"
                        icon="i-ph-play"
                        :label="t('scanCleanup.cleanUp')"
                        :disabled="!canRun"
                        @click="run"
                    />
                </template>
            </div>
        </template>
    </UModal>
</template>

<script setup lang="ts">
import type {
    IScanCleanupOptions,
    IScanCleanupPreviewResult,
    TScanCleanupPageAlignment,
} from '@contracts/electronApiScanCleanup';
import type {TDocumentRef} from '@contracts/documentRef';
import AppProgressBar from '@app/components/AppProgressBar.vue';
import ScanCleanupPreviewPane from '@app/modules/scan-cleanup/components/ScanCleanupPreviewPane.vue';
import ScanCleanupPageList from '@app/modules/scan-cleanup/components/ScanCleanupPageList.vue';
import ScanCleanupScissorsIcon from '@app/modules/scan-cleanup/components/ScanCleanupScissorsIcon.vue';
import {
    estimateScanCleanupOutputPages,
    getScanCleanupPageOverride,
    setScanCleanupPageOverride,
} from '@contracts/scanCleanupPageOverrides';
import {
    cancelScanCleanup,
    isScanCleanupRunning,
    scanCleanupRun,
    startScanCleanup,
} from '@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator';
import {
    loadScanCleanupDocumentOverrides,
    loadScanCleanupPreferences,
    resetScanCleanupDocumentOverrides,
    saveScanCleanupDocumentOverrides,
    saveScanCleanupPreferences,
} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferences';
import {getScanCleanupCapability} from '@app/utils/getScanCleanupCapability';

const {t} = useTypedI18n();
const {
    sourcePath,
    disabled = false,
    hideTrigger = false,
    currentPage = 1,
    totalPages = 1,
    documentKey = null,
} = defineProps<{
    sourcePath: TDocumentRef | null;
    disabled?: boolean;
    hideTrigger?: boolean;
    currentPage?: number;
    totalPages?: number;
    documentKey?: string | null;
}>();

const isOpen = defineModel<boolean>('open', {default: false});
const previewPage = ref(1);
const previewResult = shallowRef<IScanCleanupPreviewResult | null>(null);
const previewLoading = ref(false);
const previewError = ref('');
const previewViewMode = ref<'original' | 'cleaned'>('cleaned');
const previewZoomMode = ref<'fit' | 'actual'>('fit');
const pageListCollapsed = ref(false);
const persistedPreferences = loadScanCleanupPreferences();
const {
    runOcrAfterCleanup: persistedRunOcrAfterCleanup,
    ...persistedSettings
} = persistedPreferences;
const runOcrAfterCleanup = ref(persistedRunOcrAfterCleanup);
const cancelRequested = ref(false);
const previewCache = new Map<string, IScanCleanupPreviewResult>();
const previewClassifications = reactive(new Map<number, IScanCleanupPreviewResult['pageMetadata']['layoutClassification']>());
let previewSequence = 0;
let previewTimer: ReturnType<typeof setTimeout> | null = null;

const settings = reactive<IScanCleanupOptions>({
    ...persistedSettings,
    pageOverrides: {},
});
const preferenceDocumentKey = computed(() => documentKey ?? sourcePath);

const layoutItems = computed(() => [
    {
        value: 'auto' as const,
        label: t('scanCleanup.layout.auto'),
    },
    {
        value: 'force-single' as const,
        label: t('scanCleanup.layout.single'),
    },
    {
        value: 'force-two-page' as const,
        label: t('scanCleanup.layout.twoPage'),
    },
]);
const readingOrderItems = computed(() => [
    {
        value: 'ltr' as const,
        label: t('scanCleanup.layout.leftToRight'),
    },
    {
        value: 'rtl' as const,
        label: t('scanCleanup.layout.rightToLeft'),
    },
]);
const outputItems = computed(() => [
    {
        value: 'bw' as const,
        label: t('scanCleanup.output.bw'),
    },
    {
        value: 'grayscale' as const,
        label: t('scanCleanup.output.grayscale'),
    },
    {
        value: 'color' as const,
        label: t('scanCleanup.output.color'),
    },
]);
const alignmentIcons: Array<{
    value: TScanCleanupPageAlignment;
    icon: string
}> = [
    {
        value: 'top-left',
        icon: 'i-ph-arrow-up-left',
    },
    {
        value: 'top-center',
        icon: 'i-ph-arrow-up',
    },
    {
        value: 'top-right',
        icon: 'i-ph-arrow-up-right',
    },
    {
        value: 'center-left',
        icon: 'i-ph-arrow-left',
    },
    {
        value: 'center',
        icon: 'i-ph-dot-outline',
    },
    {
        value: 'center-right',
        icon: 'i-ph-arrow-right',
    },
    {
        value: 'bottom-left',
        icon: 'i-ph-arrow-down-left',
    },
    {
        value: 'bottom-center',
        icon: 'i-ph-arrow-down',
    },
    {
        value: 'bottom-right',
        icon: 'i-ph-arrow-down-right',
    },
];
const alignmentItems = computed(() => alignmentIcons.map(item => ({
    ...item,
    label: t(`scanCleanup.pageSize.${({
        'top-left': 'topLeft',
        'top-center': 'topCenter',
        'top-right': 'topRight',
        'center-left': 'centerLeft',
        'center': 'center',
        'center-right': 'centerRight',
        'bottom-left': 'bottomLeft',
        'bottom-center': 'bottomCenter',
        'bottom-right': 'bottomRight',
    } as const)[item.value]}`),
})));

const isRunning = isScanCleanupRunning;
const inlineError = computed(() => isOpen.value ? scanCleanupRun.lastError : '');
const hasIncludedPage = computed(() => Array.from({length: Math.max(1, totalPages)}, (_, index) => index + 1)
    .some(page => !getScanCleanupPageOverride(settings.pageOverrides, page).excluded));
const jobProgress = computed(() => scanCleanupRun.jobState?.progress ?? {
    phase: 'queued' as const,
    processedCount: 0,
    totalPages: Math.max(1, totalPages),
    percent: 0,
});
const canRun = computed(() => Boolean(sourcePath)
    && !isRunning.value
    && hasIncludedPage.value
    && settings.marginsMm >= 0
    && settings.marginsMm <= 25
    && getScanCleanupCapability() !== null);
const previewTotalPages = computed(() => previewResult.value?.totalPages ?? Math.max(1, totalPages));
const currentPageOverride = computed(() => getScanCleanupPageOverride(settings.pageOverrides, previewPage.value));
const thicknessLabel = computed(() => settings.thickness > 0 ? `+${settings.thickness}` : String(settings.thickness));
const progressText = computed(() => t('scanCleanup.progress', {
    processed: jobProgress.value.processedCount,
    total: jobProgress.value.totalPages,
}));
const triggerTooltip = computed(() => {
    if (!sourcePath) {
        return t('scanCleanup.noDocument');
    }
    if (!isRunning.value) {
        return t('scanCleanup.button');
    }
    return t('scanCleanup.runningLabel', {
        processed: jobProgress.value.processedCount,
        total: jobProgress.value.totalPages,
    });
});
const outputEstimate = computed(() => {
    const estimate = estimateScanCleanupOutputPages(totalPages, settings, previewClassifications);
    return t(estimate.exact ? 'scanCleanup.estimateExact' : 'scanCleanup.estimateAbout', {
        input: totalPages,
        output: estimate.outputPages,
    });
});

function updatePageOverride(page: number, value: Parameters<typeof setScanCleanupPageOverride>[2]) {
    const previous = getScanCleanupPageOverride(settings.pageOverrides, page);
    if (
        previous.rotation !== value.rotation
        || previous.layoutOverride !== value.layoutOverride
        || previous.manualSplitX !== value.manualSplitX
    ) {
        previewClassifications.delete(page);
    }
    setScanCleanupPageOverride(settings.pageOverrides, page, value);
}

function updateCurrentManualSplit(value: number | null) {
    updatePageOverride(previewPage.value, {
        ...currentPageOverride.value,
        manualSplitX: value,
    });
}

function resetPageOverrides() {
    settings.pageOverrides = {};
    previewClassifications.clear();
    resetScanCleanupDocumentOverrides(preferenceDocumentKey.value);
}

function handleThicknessInput(value: number | number[]) {
    settings.thickness = Array.isArray(value) ? (value[0] ?? 0) : value;
}

function previewCacheKey() {
    return JSON.stringify({
        sourcePath,
        page: previewPage.value,
        ...settings,
    });
}

function clearPreviewTimer() {
    if (previewTimer !== null) clearTimeout(previewTimer);
    previewTimer = null;
}

function cancelPreview() {
    previewSequence += 1;
    clearPreviewTimer();
    previewLoading.value = false;
    if (sourcePath) void getScanCleanupCapability()?.cancelPreview(sourcePath).catch(() => undefined);
}

function schedulePreview() {
    if (!isOpen.value || isRunning.value || !sourcePath) {
        return;
    }
    const capability = getScanCleanupCapability();
    if (!capability) {
        previewError.value = t('scanCleanup.preview.unavailable');
        return;
    }
    const sequence = ++previewSequence;
    clearPreviewTimer();
    const key = previewCacheKey();
    const cached = previewCache.get(key);
    if (cached) {
        previewResult.value = cached;
        previewLoading.value = false;
        previewError.value = '';
        return;
    }
    previewLoading.value = true;
    previewError.value = '';
    previewTimer = setTimeout(async () => {
        previewTimer = null;
        try {
            const result = await capability.preview({
                sourcePdfPath: sourcePath,
                pageNumber: previewPage.value,
                options: {...settings},
            });
            if (sequence !== previewSequence) {
                return;
            }
            previewCache.set(key, result);
            previewResult.value = result;
            previewPage.value = result.pageNumber;
            previewClassifications.set(result.pageNumber, result.pageMetadata.layoutClassification);
        } catch (error) {
            if (sequence !== previewSequence || (error instanceof Error && error.name === 'AbortError')) {
                return;
            }
            previewError.value = error instanceof Error ? error.message : t('scanCleanup.preview.unavailable');
        } finally {
            if (sequence === previewSequence) previewLoading.value = false;
        }
    }, 250);
}

function navigatePreview(delta: number) {
    previewPage.value = Math.min(previewTotalPages.value, Math.max(1, previewPage.value + delta));
}

async function run() {
    if (!sourcePath || !canRun.value) {
        return;
    }
    cancelPreview();
    cancelRequested.value = false;
    scanCleanupRun.lastError = '';
    const result = await startScanCleanup({
        sourcePdfPath: sourcePath,
        options: {...settings},
        runOcrAfterCleanup: runOcrAfterCleanup.value,
    });
    if (!result.started) scanCleanupRun.lastError = result.error ?? t('scanCleanup.failed');
}

async function cancel() {
    if (cancelRequested.value) {
        return;
    }
    cancelRequested.value = true;
    const requested = await cancelScanCleanup();
    if (!requested) cancelRequested.value = false;
}

watch(isOpen, (open) => {
    scanCleanupRun.dialogOpen = open;
    if (open) {
        previewPage.value = Math.min(Math.max(1, currentPage), previewTotalPages.value);
        if (!isRunning.value) schedulePreview();
    } else {
        cancelPreview();
    }
}, {immediate: true});
watch(preferenceDocumentKey, key => {
    previewCache.clear();
    previewClassifications.clear();
    previewResult.value = null;
    settings.pageOverrides = loadScanCleanupDocumentOverrides(key);
}, {immediate: true});
watch(() => ({
    layoutMode: settings.layoutMode,
    outputMode: settings.outputMode,
    readingOrder: settings.readingOrder,
    thickness: settings.thickness,
    crop: settings.crop,
    matchPageSize: settings.matchPageSize,
    pageAlignment: settings.pageAlignment,
    marginsMm: settings.marginsMm,
    despeckle: settings.despeckle,
    skipBlankPages: settings.skipBlankPages,
    straightenCurvedLines: settings.straightenCurvedLines,
    runOcrAfterCleanup: runOcrAfterCleanup.value,
}), preferences => saveScanCleanupPreferences(preferences), {deep: true});
watch(() => settings.pageOverrides, overrides => {
    saveScanCleanupDocumentOverrides(preferenceDocumentKey.value, overrides);
}, {deep: true});
watch(() => scanCleanupRun.openRequestRevision, () => { isOpen.value = true; });
watch(() => settings.layoutMode, () => previewClassifications.clear());
watch(() => [
    sourcePath,
    previewPage.value,
    {...settings},
] as const, schedulePreview, {deep: true});
watch(isRunning, (running) => {
    if (!running) {
        cancelRequested.value = false;
        if (isOpen.value) schedulePreview();
    }
});
onBeforeUnmount(() => {
    cancelPreview();
    if (isOpen.value) scanCleanupRun.dialogOpen = false;
});
</script>

<style scoped>
.scan-cleanup-trigger-wrap {
    position: relative;
    display: inline-flex;
}

.scan-cleanup-trigger.is-active {
    background: var(--ui-bg-elevated);
}

.scan-cleanup-running-dot {
    position: absolute;
    inset-inline-end: var(--app-space-xs);
    inset-block-end: var(--app-space-xs);
    width: var(--app-space-3xl);
    height: var(--app-space-3xl);
    border: 1px solid var(--ui-bg);
    border-radius: var(--app-radius-full);
    background: var(--ui-primary);
    animation: scan-cleanup-pulse 1.4s ease-in-out infinite;
    pointer-events: none;
}

.hidden-trigger {
    display: none;
}

.scan-cleanup-workspace {
    display: grid;
    min-height: 0;
    flex: 1;
    grid-template-columns: var(--app-scan-dialog-rail-width) minmax(3rem, var(--app-scan-page-list-width)) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    overflow: hidden;
}

.scan-cleanup-workspace.is-page-list-collapsed {
    grid-template-columns: var(--app-scan-dialog-rail-width) 3rem minmax(0, 1fr);
}

.scan-cleanup-options-rail {
    min-width: 0;
    overflow-y: auto;
    border: 0;
    border-inline-end: 1px solid var(--ui-border);
    padding: var(--app-space-12xl);
}

.scan-cleanup-options-rail:disabled {
    opacity: var(--app-scan-disabled-opacity);
}

.scan-cleanup-option-group {
    display: grid;
    gap: var(--app-space-9xl);
    padding-block-end: var(--app-space-12xl);
}

.scan-cleanup-option-group + .scan-cleanup-option-group {
    border-block-start: 1px solid var(--ui-border);
    padding-block-start: var(--app-space-12xl);
}

.scan-cleanup-option-group h3 {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
}

.scan-cleanup-segmented {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
}

.scan-cleanup-segmented > * {
    border-radius: 0;
}

.scan-cleanup-segmented > :first-child {
    border-start-start-radius: var(--app-radius-md);
    border-end-start-radius: var(--app-radius-md);
}

.scan-cleanup-segmented > :last-child {
    border-start-end-radius: var(--app-radius-md);
    border-end-end-radius: var(--app-radius-md);
}

.scan-cleanup-scale {
    display: flex;
    justify-content: space-between;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.scan-cleanup-alignment-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--app-space-sm);
}

.scan-cleanup-footnote {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.scan-cleanup-details-popover {
    display: grid;
    max-width: var(--app-scan-details-width);
    gap: var(--app-space-9xl);
    padding: var(--app-space-12xl);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body-sm);
}

.scan-cleanup-error {
    margin-block-end: var(--app-space-12xl);
    border-radius: var(--app-radius-md);
    background: color-mix(in srgb, var(--ui-error) 12%, transparent);
    padding: var(--app-space-9xl);
    color: var(--ui-error);
    font-size: var(--app-text-size-body-sm);
}

.scan-cleanup-preview-hero {
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    padding: var(--app-space-12xl);
}

.scan-cleanup-progress-overlay {
    position: absolute;
    inset: 0;
    z-index: var(--app-z-local-overlay);
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--ui-bg) 68%, transparent);
    backdrop-filter: blur(1px);
}

.scan-cleanup-progress-card {
    display: grid;
    min-width: var(--app-scan-progress-card-width);
    justify-items: center;
    gap: var(--app-space-9xl);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-xl);
    background: var(--ui-bg);
    padding: var(--app-space-13xl);
    box-shadow: var(--shadow-popup);
    text-align: center;
}

.scan-cleanup-progress-card span {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body-sm);
}

.scan-cleanup-footer-info {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--app-space-9xl);
}

.scan-cleanup-estimate {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body-sm);
}

.scan-cleanup-footer-actions {
    display: flex;
    gap: var(--app-space-9xl);
}

@keyframes scan-cleanup-pulse {
    50% {
        opacity: 0.45;
        transform: scale(0.8);
    }
}
</style>
