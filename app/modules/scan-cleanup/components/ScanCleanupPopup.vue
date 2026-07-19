<template>
    <UModal
        v-model:open="isOpen"
        :title="t('scanCleanup.title')"
        :dismissible="!isRunning"
        :ui="{content: 'sm:max-w-3xl', footer: 'justify-end gap-2'}"
    >
        <template #description>
            <span class="sr-only">{{ t('scanCleanup.description') }}</span>
        </template>

        <AppTooltip :text="triggerTooltip" :delay-duration="1200">
            <UButton
                v-if="!hideTrigger"
                class="scan-cleanup-trigger"
                :class="{'is-active': isOpen || isRunning}"
                :disabled="disabled || !sourcePath"
                color="neutral"
                variant="ghost"
                size="md"
                square
                icon="i-ph-broom"
                :aria-label="triggerTooltip"
                :aria-pressed="isOpen || isRunning"
                type="button"
            />
            <span v-else class="hidden-trigger" aria-hidden="true" />
        </AppTooltip>

        <template #body>
            <div v-if="state === 'configure' || state === 'error'" class="scan-cleanup-body">
                <div v-if="state === 'error'" class="notice is-error" role="alert">{{ error }}</div>
                <div class="scan-cleanup-config">
                    <div class="scan-cleanup-options">
                        <UFormField :label="t('scanCleanup.layout.label')">
                            <USelect v-model="settings.layoutMode" :items="layoutItems" value-key="value" class="w-full" />
                        </UFormField>
                        <UFormField :label="t('scanCleanup.output.label')">
                            <URadioGroup v-model="settings.outputMode" :items="outputItems" value-key="value" orientation="horizontal" />
                        </UFormField>
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
                            <div class="thickness-scale" aria-hidden="true">
                                <span>{{ t('scanCleanup.thickness.thinner') }}</span>
                                <span class="thickness-default">{{ t('scanCleanup.thickness.default') }}</span>
                                <span>{{ t('scanCleanup.thickness.thicker') }}</span>
                            </div>
                        </UFormField>
                        <UCheckbox v-model="settings.crop" :label="t('scanCleanup.crop.label')" />
                        <UFormField v-if="settings.crop" :label="t('scanCleanup.crop.margins')">
                            <UInput v-model.number="settings.marginsMm" type="number" :min="0" :max="25" :step="1" />
                        </UFormField>
                        <UCheckbox
                            v-if="settings.outputMode === 'bw'"
                            v-model="settings.despeckle"
                            :label="t('scanCleanup.despeckle')"
                        />
                        <UCheckbox v-model="settings.matchPageSize" :label="t('scanCleanup.pageSize.match')" />
                        <UFormField v-if="settings.matchPageSize" :label="t('scanCleanup.pageSize.alignment')">
                            <div class="alignment-grid" role="radiogroup" :aria-label="t('scanCleanup.pageSize.alignment')">
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
                        <div class="notice">{{ t('scanCleanup.rasterNotice') }}</div>
                        <div class="notice is-warning">{{ t('scanCleanup.lossNotice') }}</div>
                    </div>
                    <ScanCleanupPreviewPane
                        :result="previewResult"
                        :loading="previewLoading"
                        :error="previewError"
                        :show-before="showBefore"
                        :match-page-size="settings.matchPageSize"
                        :alignment="settings.pageAlignment"
                        :page-number="previewPage"
                        :total-pages="previewTotalPages"
                        @previous="navigatePreview(-1)"
                        @next="navigatePreview(1)"
                        @update:show-before="showBefore = $event"
                    />
                </div>
            </div>
            <div v-else-if="state === 'running'" class="terminal-panel" role="status" aria-live="polite">
                <AppProgressBar :value="jobState?.progress.percent ?? 0" />
                <span>{{ progressText }}</span>
            </div>
            <div v-else class="terminal-panel" role="status" aria-live="polite">
                <UIcon name="i-ph-check-circle" class="size-8 result-icon" />
                <span>{{ t('scanCleanup.complete') }}</span>
                <span v-if="summary" class="summary-text">
                    {{ t('scanCleanup.summary', {
                        input: summary.inputPages,
                        output: summary.outputPages,
                        spreads: summary.spreadsSplit,
                        offcuts: summary.offcutsDiscarded,
                    }) }}
                </span>
                <span v-if="summary?.warnings.length" class="summary-text">
                    {{ t('scanCleanup.warningCount', {count: summary.warnings.length}) }}
                </span>
            </div>
        </template>

        <template #footer>
            <template v-if="state === 'running'">
                <UButton
                    color="neutral"
                    variant="outline"
                    :label="cancelRequested ? t('scanCleanup.canceling') : t('scanCleanup.cancel')"
                    :disabled="cancelRequested"
                    @click="cancel"
                />
            </template>
            <template v-else-if="state === 'complete'">
                <UButton color="primary" :label="t('common.close')" @click="isOpen = false" />
            </template>
            <template v-else>
                <UButton color="neutral" variant="outline" :label="t('common.cancel')" @click="isOpen = false" />
                <UButton color="primary" icon="i-ph-play" :label="t('scanCleanup.run')" :disabled="!canRun" @click="run" />
            </template>
        </template>
    </UModal>
</template>

<script setup lang="ts">
import type {
    IScanCleanupOptions,
    IScanCleanupPreviewResult,
    IScanCleanupSummary,
    TScanCleanupJobState,
} from '@contracts/electronApiScanCleanup';
import type { TDocumentRef } from '@contracts/documentRef';
import AppProgressBar from '@app/components/AppProgressBar.vue';
import ScanCleanupPreviewPane from '@app/modules/scan-cleanup/components/ScanCleanupPreviewPane.vue';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';
import { getScanCleanupCapability } from '@app/utils/getScanCleanupCapability';

const {t} = useTypedI18n();
const {
    sourcePath,
    disabled = false,
    hideTrigger = false,
    currentPage = 1,
    totalPages = 1,
} = defineProps<{
    sourcePath: TDocumentRef | null;
    disabled?: boolean;
    hideTrigger?: boolean;
    currentPage?: number;
    totalPages?: number;
}>();

const isOpen = defineModel<boolean>('open', {default: false});
const state = ref<'configure' | 'running' | 'complete' | 'error'>('configure');
const error = ref('');
const jobState = ref<TScanCleanupJobState | null>(null);
const summary = ref<IScanCleanupSummary | null>(null);
const cancelRequested = ref(false);
const previewPage = ref(1);
const previewResult = shallowRef<IScanCleanupPreviewResult | null>(null);
const previewLoading = ref(false);
const previewError = ref('');
const showBefore = ref(false);
const previewCache = new Map<string, IScanCleanupPreviewResult>();
let previewSequence = 0;
let previewTimer: ReturnType<typeof setTimeout> | null = null;
let activeJobId: string | null = null;
let unsubscribe: (() => void) | null = null;
const settings = reactive<IScanCleanupOptions>({
    layoutMode: 'auto',
    outputMode: 'bw',
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center',
    marginsMm: 5,
    despeckle: true,
});
const layoutItems = computed(() => [
    {
        value: 'auto',
        label: t('scanCleanup.layout.auto'),
    },
    {
        value: 'force-single',
        label: t('scanCleanup.layout.single'),
    },
    {
        value: 'force-two-page',
        label: t('scanCleanup.layout.twoPage'),
    },
]);
const outputItems = computed(() => [
    {
        value: 'bw',
        label: t('scanCleanup.output.bw'),
    },
    {
        value: 'grayscale',
        label: t('scanCleanup.output.grayscale'),
    },
]);
const alignmentItems = computed(() => [
    {
        value: 'top-left' as const,
        label: t('scanCleanup.pageSize.topLeft'),
        icon: 'i-ph-arrow-up-left',
    },
    {
        value: 'top-center' as const,
        label: t('scanCleanup.pageSize.topCenter'),
        icon: 'i-ph-arrow-up',
    },
    {
        value: 'top-right' as const,
        label: t('scanCleanup.pageSize.topRight'),
        icon: 'i-ph-arrow-up-right',
    },
    {
        value: 'center-left' as const,
        label: t('scanCleanup.pageSize.centerLeft'),
        icon: 'i-ph-arrow-left',
    },
    {
        value: 'center' as const,
        label: t('scanCleanup.pageSize.center'),
        icon: 'i-ph-dot-outline',
    },
    {
        value: 'center-right' as const,
        label: t('scanCleanup.pageSize.centerRight'),
        icon: 'i-ph-arrow-right',
    },
    {
        value: 'bottom-left' as const,
        label: t('scanCleanup.pageSize.bottomLeft'),
        icon: 'i-ph-arrow-down-left',
    },
    {
        value: 'bottom-center' as const,
        label: t('scanCleanup.pageSize.bottomCenter'),
        icon: 'i-ph-arrow-down',
    },
    {
        value: 'bottom-right' as const,
        label: t('scanCleanup.pageSize.bottomRight'),
        icon: 'i-ph-arrow-down-right',
    },
]);
const isRunning = computed(() => state.value === 'running');
const canRun = computed(() => Boolean(sourcePath)
    && settings.marginsMm >= 0
    && settings.marginsMm <= 25
    && getScanCleanupCapability() !== null);
const triggerTooltip = computed(() => sourcePath ? t('scanCleanup.button') : t('scanCleanup.noDocument'));
const thicknessLabel = computed(() => settings.thickness > 0 ? `+${settings.thickness}` : String(settings.thickness));
const previewTotalPages = computed(() => previewResult.value?.totalPages ?? Math.max(1, totalPages));
const progressText = computed(() => {
    const progress = jobState.value?.progress;
    return progress
        ? t('scanCleanup.progress', {
            processed: progress.processedCount,
            total: progress.totalPages,
        })
        : t('scanCleanup.preparing');
});

function handleState(next: TScanCleanupJobState) {
    if (next.jobId !== activeJobId) {
        return;
    }
    jobState.value = next;
    if (next.status === 'completed') {
        summary.value = next.summary;
        state.value = 'complete';
    } else if (next.status === 'failed') {
        error.value = next.error;
        state.value = 'error';
    } else if (next.status === 'canceled') {
        error.value = t('scanCleanup.canceled');
        state.value = 'error';
    }
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

function isAbortError(previewFailure: unknown) {
    return previewFailure instanceof Error && previewFailure.name === 'AbortError';
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
    if (!isOpen.value || (state.value !== 'configure' && state.value !== 'error') || !sourcePath) {
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
        previewError.value = '';
        previewLoading.value = false;
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
            if (sequence !== previewSequence || !isOpen.value) {
                return;
            }
            previewCache.set(key, result);
            previewResult.value = result;
            previewPage.value = result.pageNumber;
        } catch (previewFailure) {
            if (sequence !== previewSequence || isAbortError(previewFailure)) {
                return;
            }
            previewError.value = previewFailure instanceof Error
                ? previewFailure.message
                : t('scanCleanup.preview.unavailable');
        } finally {
            if (sequence === previewSequence) previewLoading.value = false;
        }
    }, 250);
}

function navigatePreview(delta: number) {
    previewPage.value = Math.min(previewTotalPages.value, Math.max(1, previewPage.value + delta));
}

async function run() {
    const capability = getScanCleanupCapability();
    if (!capability || !sourcePath || !canRun.value) {
        return;
    }
    const baseName = sourcePath.split(/[\\/]/u).pop()?.replace(/\.pdf$/iu, '') ?? 'document';
    const outputPdfPath = await getDocumentFilesCapability().savePdfDialog(`${baseName}-cleaned.pdf`);
    if (!outputPdfPath) {
        return;
    }
    cancelPreview();
    error.value = '';
    summary.value = null;
    cancelRequested.value = false;
    state.value = 'running';
    unsubscribe?.();
    unsubscribe = capability.onJobState(handleState);
    const result = await capability.start({
        sourcePdfPath: sourcePath,
        outputPdfPath,
        options: {...settings},
    });
    if (!result.started) {
        error.value = result.error ?? t('scanCleanup.failed');
        state.value = 'error';
        return;
    }
    activeJobId = result.jobId;
    const restored = await capability.subscribeJob(result.jobId);
    if (restored) handleState(restored);
}

async function cancel() {
    const capability = getScanCleanupCapability();
    if (!capability || !activeJobId || cancelRequested.value) {
        return;
    }
    cancelRequested.value = true;
    await capability.cancel(activeJobId);
}

watch(isOpen, open => {
    if (open && !isRunning.value && state.value !== 'complete') {
        state.value = 'configure';
        previewCache.clear();
        previewPage.value = Math.min(Math.max(1, totalPages), Math.max(1, currentPage));
        previewResult.value = null;
        previewError.value = '';
        showBefore.value = false;
        schedulePreview();
    } else if (!open) {
        cancelPreview();
        previewCache.clear();
        previewResult.value = null;
        previewError.value = '';
    }
});
watch([
    previewPage,
    () => settings.layoutMode,
    () => settings.outputMode,
    () => settings.thickness,
    () => settings.crop,
    () => settings.marginsMm,
    () => settings.despeckle,
    () => settings.matchPageSize,
    () => settings.pageAlignment,
], schedulePreview, {flush: 'post'});
onBeforeUnmount(() => {
    cancelPreview();
    unsubscribe?.();
});
</script>

<style scoped>
.scan-cleanup-trigger,
.hidden-trigger {
    width: var(--toolbar-control-height, var(--app-toolbar-control-size));
    height: var(--toolbar-control-height, var(--app-toolbar-control-size));
}

.hidden-trigger {
    display: block;
    visibility: hidden;
}

.scan-cleanup-trigger.is-active {
    background: var(--app-toolbar-control-active-bg);
    border-color: var(--app-toolbar-control-active-border);
    color: var(--app-toolbar-control-hover-fg);
}

.scan-cleanup-body {
    display: flex;
    flex-direction: column;
    gap: var(--app-space-3xl);
}

.scan-cleanup-config {
    display: grid;
    grid-template-columns: minmax(14rem, 0.8fr) minmax(20rem, 1.2fr);
    gap: var(--app-space-9xl);
}

.scan-cleanup-options {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: var(--app-space-3xl);
}

.thickness-scale {
    display: flex;
    justify-content: space-between;
    margin-top: var(--app-space-sm);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.thickness-default {
    position: relative;
}

.thickness-default::before {
    position: absolute;
    top: calc(-1 * var(--app-space-5xl));
    left: 50%;
    width: var(--app-divider-width);
    height: var(--app-space-3xl);
    background: var(--ui-border);
    content: '';
}

.notice {
    padding: var(--app-space-lg);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-md);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.notice.is-warning {
    border-color: var(--ui-warning);
    color: var(--ui-warning);
}

.notice.is-error {
    border-color: var(--ui-error);
    color: var(--ui-error);
}

.terminal-panel {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--app-space-3xl);
    padding: var(--app-space-9xl) 0;
    text-align: center;
}

.alignment-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--app-space-sm);
    width: min(12rem, 100%);
}

.alignment-grid > * {
    justify-content: center;
}

.terminal-panel :deep(.app-progress-bar) {
    width: 100%;
}

.result-icon {
    color: var(--ui-success);
}

.summary-text {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

@media (width <= 48rem) {
    .scan-cleanup-config {
        grid-template-columns: minmax(0, 1fr);
    }
}
</style>
