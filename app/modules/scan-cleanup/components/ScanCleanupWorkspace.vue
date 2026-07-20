<template>
    <Teleport
        v-if="toolbarActive"
        to="#editor-global-toolbar-host"
        :disabled="!canTeleportToolbar"
    >
        <ScanCleanupToolbar
            :can-detect-all="canDetectAll"
            :can-run="canRun"
            :cancel-requested="cancelRequested"
            :cleanup-total="cleanupProgressTotal"
            :detection-cancel-requested="detectionCancelRequested"
            :detection-detected="detectionProgress.detectedCount"
            :detection-error="detectionError"
            :detection-total="detectionProgress.totalPages"
            :is-detecting="detectionPending"
            :is-running="isRunning"
            :output-estimate="outputEstimate"
            :percent="jobProgress.percent"
            :processed-count="jobProgress.processedCount"
            :progress-text="progressText"
            :run-ocr-after-cleanup="runOcrAfterCleanup"
            @cancel="cancel"
            @cancel-detection="cancelDetection"
            @detect-all="detectAllPages"
            @done="done"
            @run="run"
            @update:run-ocr-after-cleanup="runOcrAfterCleanup = $event"
        />
    </Teleport>
    <section
        class="scan-cleanup-surface"
        role="dialog"
        :aria-label="t('scanCleanup.workspaceTitle')"
    >
        <div
            class="scan-cleanup-workspace"
            :aria-busy="isRunning"
        >
            <fieldset class="scan-cleanup-options-rail app-scrollbar app-scroll-region--balanced" :disabled="isRunning">
                <div v-if="inlineError" class="scan-cleanup-error" role="alert">{{ inlineError }}</div>
                <UTabs
                    :model-value="settingsScope"
                    :items="settingsTabItems"
                    :content="false"
                    size="sm"
                    variant="link"
                    class="scan-cleanup-settings-tabs"
                    :aria-label="t('scanCleanup.settings.tabsLabel')"
                    @update:model-value="updateSettingsScope"
                />
                <p
                    v-if="selectedPages.size === 0"
                    class="scan-cleanup-selection-hint"
                    role="status"
                >{{ t('scanCleanup.settings.selectionDisabled') }}</p>

                <div v-if="settingsScope === 'document'" class="scan-cleanup-settings-content">
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
                        <UCheckbox
                            :model-value="settings.preserveOriginalQuality === true"
                            :label="t('scanCleanup.output.preserveOriginalQuality')"
                            @update:model-value="settings.preserveOriginalQuality = $event === true"
                        />
                        <ScanCleanupSegmented
                            :model-value="settings.outputMode"
                            :items="outputItems.map(item => ({...item, ariaLabel: item.fullLabel}))"
                            :group-label="t('scanCleanup.output.label')"
                            :disabled="settings.preserveOriginalQuality === true"
                            @update:model-value="updateOutputMode"
                        />
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
                                :disabled="settings.preserveOriginalQuality === true"
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
                            :disabled="settings.preserveOriginalQuality === true"
                        />
                        <p v-if="settings.preserveOriginalQuality" class="scan-cleanup-lossless-explanation">
                            {{ t('scanCleanup.output.losslessDisabledOptions') }}
                        </p>
                    </section>

                    <section class="scan-cleanup-option-group">
                        <h3>{{ t('scanCleanup.groups.cropSize') }}</h3>
                        <UCheckbox v-model="settings.crop" :label="t('scanCleanup.crop.label')" />
                        <UFormField v-if="settings.crop" :label="t('scanCleanup.crop.margins')">
                            <UInput v-model.number="settings.marginsMm" type="number" :min="0" :max="25" :step="1" />
                        </UFormField>
                        <UCheckbox v-model="settings.matchPageSize" :label="t('scanCleanup.pageSize.match')" />
                        <UCheckbox
                            v-model="settings.skipBlankPages"
                            :label="t('scanCleanup.crop.skipBlank')"
                            :disabled="settings.preserveOriginalQuality === true"
                        />
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
                                    @click="updateCurrentPlacementAll(item.value)"
                                />
                            </div>
                        </UFormField>
                    </section>

                    <div class="scan-cleanup-footnote">
                        <span>{{ t(settings.preserveOriginalQuality ? 'scanCleanup.contentPreserved' : 'scanCleanup.imageOnly') }}</span>
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
                                    <template v-if="settings.preserveOriginalQuality">
                                        <p>{{ t('scanCleanup.losslessNotice') }}</p>
                                        <p>{{ t('scanCleanup.losslessLimitNotice') }}</p>
                                    </template>
                                    <template v-else>
                                        <p>{{ t('scanCleanup.rasterNotice') }}</p>
                                        <p>{{ t('scanCleanup.lossNotice') }}</p>
                                    </template>
                                </div>
                            </template>
                        </UPopover>
                    </div>
                </div>

                <div v-else class="scan-cleanup-settings-content scan-cleanup-selection-settings">
                    <div class="scan-cleanup-selection-actions">
                        <UDropdownMenu :items="applyScopeItems" :content="{side: 'bottom', align: 'end'}">
                            <UButton
                                type="button"
                                color="neutral"
                                variant="outline"
                                size="sm"
                                :label="t('scanCleanup.settings.applyTo')"
                                trailing-icon="i-ph-caret-down"
                            />
                        </UDropdownMenu>
                        <UPopover v-model:open="resetOverridesPopoverOpen" portal :content="{side: 'bottom', align: 'end'}">
                            <UButton
                                type="button"
                                color="neutral"
                                variant="outline"
                                size="sm"
                                :label="t('scanCleanup.pages.resetAll')"
                                :disabled="!hasPageOverrides"
                            />
                            <template #content>
                                <div class="scan-cleanup-reset-confirmation">
                                    <strong>{{ t('scanCleanup.pages.resetConfirm') }}</strong>
                                    <span>{{ t('scanCleanup.pages.resetConfirmBody') }}</span>
                                    <div class="scan-cleanup-reset-actions">
                                        <UButton
                                            type="button"
                                            color="neutral"
                                            variant="ghost"
                                            size="sm"
                                            :label="t('common.cancel')"
                                            @click="resetOverridesPopoverOpen = false"
                                        />
                                        <UButton
                                            type="button"
                                            color="primary"
                                            size="sm"
                                            :label="t('scanCleanup.pages.resetAction')"
                                            @click="confirmResetPageOverrides"
                                        />
                                    </div>
                                </div>
                            </template>
                        </UPopover>
                    </div>

                    <section class="scan-cleanup-option-group">
                        <h3>{{ t('scanCleanup.groups.layout') }}</h3>
                        <div class="scan-cleanup-selection-field">
                            <div class="scan-cleanup-selection-field-label">
                                <span>{{ t('scanCleanup.settings.layoutOverride') }}</span>
                                <UBadge v-if="selectionLayoutOverride.mixed" color="neutral" variant="soft" size="sm">
                                    {{ t('scanCleanup.settings.mixed') }}
                                </UBadge>
                            </div>
                            <USelect
                                :model-value="selectionLayoutModelValue"
                                :items="selectionLayoutItems"
                                value-key="value"
                                class="w-full"
                                :aria-label="t('scanCleanup.settings.layoutOverride')"
                                @update:model-value="handleSelectionLayout"
                            />
                        </div>
                        <div class="scan-cleanup-selection-field">
                            <div class="scan-cleanup-selection-field-label">
                                <span>{{ t('scanCleanup.settings.rotation') }}</span>
                                <UBadge v-if="selectionRotation.mixed" color="neutral" variant="soft" size="sm">
                                    {{ t('scanCleanup.settings.mixed') }}
                                </UBadge>
                            </div>
                            <USelect
                                :model-value="selectionRotationModelValue"
                                :items="selectionRotationItems"
                                value-key="value"
                                class="w-full"
                                :aria-label="t('scanCleanup.settings.rotation')"
                                @update:model-value="handleSelectionRotation"
                            />
                        </div>
                        <div class="scan-cleanup-selection-field">
                            <div class="scan-cleanup-selection-field-label">
                                <span>{{ t('scanCleanup.settings.inOutput') }}</span>
                                <UBadge v-if="selectionExcluded.mixed" color="neutral" variant="soft" size="sm">
                                    {{ t('scanCleanup.settings.mixed') }}
                                </UBadge>
                            </div>
                            <USelect
                                :model-value="selectionInclusionModelValue"
                                :items="selectionInclusionItems"
                                value-key="value"
                                class="w-full"
                                :aria-label="t('scanCleanup.settings.inOutput')"
                                @update:model-value="handleSelectionInclusion"
                            />
                        </div>
                    </section>

                    <section class="scan-cleanup-option-group">
                        <h3>{{ t('scanCleanup.groups.cropSize') }}</h3>
                        <div class="scan-cleanup-selection-reset-row">
                            <div>
                                <span>{{ t('scanCleanup.settings.manualSplit') }}</span>
                                <UBadge color="neutral" variant="soft" size="sm">
                                    {{ selectionManualSplitLabel }}
                                </UBadge>
                            </div>
                            <UButton
                                type="button"
                                color="neutral"
                                variant="outline"
                                size="xs"
                                :label="t('scanCleanup.settings.reset')"
                                :disabled="!selectionManualSplit.mixed && selectionManualSplit.value === null"
                                @click="resetSelectionManualSplit"
                            />
                        </div>
                        <div class="scan-cleanup-selection-reset-row">
                            <div>
                                <span>{{ t('scanCleanup.settings.contentBox') }}</span>
                                <UBadge color="neutral" variant="soft" size="sm">
                                    {{ selectionContentBoxesLabel }}
                                </UBadge>
                            </div>
                            <UButton
                                type="button"
                                color="neutral"
                                variant="outline"
                                size="xs"
                                :label="t('scanCleanup.settings.reset')"
                                :disabled="!hasSelectionContentBoxes"
                                @click="resetSelectionContentBoxes"
                            />
                        </div>
                        <div class="scan-cleanup-selection-field">
                            <div class="scan-cleanup-selection-field-label">
                                <span>{{ t('scanCleanup.pageSize.alignment') }}</span>
                                <UBadge v-if="selectionPlacementAlignment.mixed" color="neutral" variant="soft" size="sm">
                                    {{ t('scanCleanup.settings.mixed') }}
                                </UBadge>
                            </div>
                            <div
                                class="scan-cleanup-alignment-grid"
                                role="radiogroup"
                                :aria-label="t('scanCleanup.settings.selectionAlignment')"
                            >
                                <UButton
                                    v-for="item in alignmentItems"
                                    :key="item.value"
                                    :aria-label="item.label"
                                    :aria-checked="!selectionPlacementAlignment.mixed && selectionPlacementAlignment.value === item.value"
                                    :color="!selectionPlacementAlignment.mixed && selectionPlacementAlignment.value === item.value ? 'primary' : 'neutral'"
                                    :variant="!selectionPlacementAlignment.mixed && selectionPlacementAlignment.value === item.value ? 'soft' : 'outline'"
                                    :disabled="!settings.matchPageSize"
                                    role="radio"
                                    size="sm"
                                    :icon="item.icon"
                                    @click="updateSelectionPlacement(item.value)"
                                />
                            </div>
                            <p v-if="!settings.matchPageSize" class="scan-cleanup-selection-hint">
                                {{ t('scanCleanup.settings.enableMatchPageSize') }}
                            </p>
                        </div>
                    </section>
                </div>
            </fieldset>

            <ScanCleanupThumbnailRail
                :source="pageSource"
                :source-pending="pageSourcePending"
                :total-pages="previewTotalPages"
                :selection-leader="selectionLeader"
                :selected-pages="selectedPages"
                :overrides="settings.pageOverrides"
                :classifications="previewClassifications"
                :confidences="previewConfidences"
                :disabled="isRunning"
                :processed-pages="processedPages"
                :detection-active="detectionPending"
                @select-page="selectPage"
                @update:override="updatePageOverride"
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
                    :stale-page="previewResult !== null && previewResult.pageNumber !== previewPage"
                    :manual-split-x="currentPageOverride.manualSplitX"
                    :reading-order="settings.readingOrder"
                    :manual-content-boxes="currentPageOverride.manualContentBoxes ?? {}"
                    :placement-overrides="currentPageOverride.placementOverrides ?? {}"
                    :lossless="settings.preserveOriginalQuality === true"
                    :show-first-run-guidance="showFirstRunGuidance"
                    @previous="navigatePreview(-1)"
                    @next="navigatePreview(1)"
                    @retry="retryPreview"
                    @update:view-mode="previewViewMode = $event"
                    @update:zoom-mode="previewZoomMode = $event"
                    @update:manual-split-x="updateCurrentManualSplit"
                    @update:manual-content-box="updateCurrentManualContentBox"
                    @update:placement="updateCurrentPlacement"
                    @dismiss-first-run-guidance="dismissFirstRunGuidance"
                />
            </div>
        </div>

    </section>
</template>

<script setup lang="ts">
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    TScanCleanupOutputMode,
    TScanCleanupPageLayoutOverride,
    TScanCleanupPageRotation,
} from '@contracts/electronApiScanCleanup';
import type { IDocumentPageSource } from '@app/utils/document-viewer/source/documentPageSource';
import type { IScanCleanupTabSessionState } from '@app/modules/workspace-shell/public';
import ScanCleanupPreviewPane from '@app/modules/scan-cleanup/components/ScanCleanupPreviewPane.vue';
import ScanCleanupSegmented from '@app/modules/scan-cleanup/components/ScanCleanupSegmented.vue';
import ScanCleanupThumbnailRail from '@app/modules/scan-cleanup/components/ScanCleanupThumbnailRail.vue';
import ScanCleanupToolbar from '@app/modules/scan-cleanup/components/ScanCleanupToolbar.vue';
import { useScanCleanupWorkspaceSession } from '@app/modules/scan-cleanup/composables/useScanCleanupWorkspaceSession';

const { t } = useTypedI18n();
const {
    sourcePath,
    currentPage = 1,
    totalPages = 1,
    documentKey = null,
    pageSource = null,
    pageSourcePending = false,
    sessionState = null,
    toolbarActive = true,
    canTeleportToolbar = false,
} = defineProps<{
    sourcePath: TDocumentRef | null;
    currentPage?: number;
    totalPages?: number;
    documentKey?: string | null;
    pageSource?: IDocumentPageSource | null;
    pageSourcePending?: boolean;
    sessionState?: IScanCleanupTabSessionState | null;
    toolbarActive?: boolean;
    canTeleportToolbar?: boolean;
}>();
const emit = defineEmits<{
    done: [];
    'update:session-state': [state: IScanCleanupTabSessionState];
}>();
const {
    alignmentItems,
    applyLeaderOverrides,
    cancel,
    cancelDetection,
    cancelRequested,
    canDetectAll,
    canRun,
    currentPageOverride,
    handleThicknessInput,
    detectAllPages,
    detectionCancelRequested,
    detectionError,
    detectionPending,
    detectionProgress,
    inlineError,
    isRunning,
    jobProgress,
    layoutItems,
    navigatePreview,
    outputEstimate,
    outputItems,
    previewClassifications,
    previewConfidences,
    previewError,
    previewLoading,
    previewPage,
    processedPages,
    previewResult,
    previewTotalPages,
    previewViewMode,
    previewZoomMode,
    progressText,
    readingOrderItems,
    resetPageOverrides,
    resetSelectionContentBoxes,
    resetSelectionManualSplit,
    retryPreview,
    run,
    runOcrAfterCleanup,
    showFirstRunGuidance,
    dismissFirstRunGuidance,
    selectedPages,
    selectionLeader,
    selectionContentBoxes,
    selectionExcluded,
    selectionLayoutOverride,
    selectionManualSplit,
    selectionPlacementAlignment,
    selectionRotation,
    selectPage,
    settings,
    thicknessLabel,
    updateCurrentManualSplit,
    updateCurrentManualContentBox,
    updateCurrentPlacement,
    updateCurrentPlacementAll,
    updatePageOverride,
    updateSelectionExcluded,
    updateSelectionLayoutOverride,
    updateSelectionPlacement,
    updateSelectionRotation,
} = useScanCleanupWorkspaceSession({
    active: () => true,
    sourcePath: () => sourcePath,
    documentKey: () => documentKey,
    currentPage: () => currentPage,
    totalPages: () => totalPages,
    initialPreviewPage: () => sessionState?.previewPage,
    initialPreviewViewMode: () => sessionState?.previewViewMode,
    initialPreviewZoomMode: () => sessionState?.previewZoomMode,
});
type TScanCleanupSettingsScope = 'document' | 'selection';
const settingsScope = ref<TScanCleanupSettingsScope>('document');
const resetOverridesPopoverOpen = ref(false);
const hasPageOverrides = computed(() => Object.keys(settings.pageOverrides).length > 0);
const cleanupProgressTotal = computed(() => Math.max(jobProgress.value.totalPages, previewTotalPages.value));
const settingsTabItems = computed(() => [
    {
        value: 'document' as const,
        label: t('scanCleanup.settings.document'),
    },
    {
        value: 'selection' as const,
        label: t('scanCleanup.settings.selection', {count: selectedPages.value.size}),
        disabled: selectedPages.value.size === 0,
        title: selectedPages.value.size === 0 ? t('scanCleanup.settings.selectionDisabled') : undefined,
    },
]);
const selectionLayoutItems = computed(() => [
    ...(selectionLayoutOverride.value.mixed ? [{
        value: 'mixed' as const,
        label: t('scanCleanup.settings.mixed'),
        disabled: true,
    }] : []),
    {
        value: 'auto' as const,
        label: t('scanCleanup.pages.override.auto'),
    },
    {
        value: 'single' as const,
        label: t('scanCleanup.pages.override.single'),
    },
    {
        value: 'spread' as const,
        label: t('scanCleanup.pages.override.spread'),
    },
    {
        value: 'keep-left' as const,
        label: t('scanCleanup.pages.override.keepLeft'),
    },
    {
        value: 'keep-right' as const,
        label: t('scanCleanup.pages.override.keepRight'),
    },
]);
const selectionRotationItems = computed(() => [
    ...(selectionRotation.value.mixed ? [{
        value: 'mixed',
        label: t('scanCleanup.settings.mixed'),
        disabled: true,
    }] : []),
    ...([
        0,
        90,
        180,
        270,
    ] as const).map(value => ({
        value: String(value),
        label: t('scanCleanup.settings.rotationDegrees', {value}),
    })),
]);
const selectionInclusionItems = computed(() => [
    ...(selectionExcluded.value.mixed ? [{
        value: 'mixed' as const,
        label: t('scanCleanup.settings.mixed'),
        disabled: true,
    }] : []),
    {
        value: 'included' as const,
        label: t('scanCleanup.pages.includeInOutput'),
    },
    {
        value: 'excluded' as const,
        label: t('scanCleanup.pages.excludedFromOutput'),
    },
]);
const selectionLayoutModelValue = computed(() => selectionLayoutOverride.value.mixed
    ? 'mixed'
    : selectionLayoutOverride.value.value ?? 'auto');
const selectionRotationModelValue = computed(() => selectionRotation.value.mixed
    ? 'mixed'
    : String(selectionRotation.value.value ?? 0));
const selectionInclusionModelValue = computed(() => {
    if (selectionExcluded.value.mixed) {
        return 'mixed';
    }
    return selectionExcluded.value.value ? 'excluded' : 'included';
});
const selectionManualSplitLabel = computed(() => {
    if (selectionManualSplit.value.mixed) {
        return t('scanCleanup.settings.mixed');
    }
    return selectionManualSplit.value.value === null
        ? t('scanCleanup.settings.automatic')
        : t('scanCleanup.settings.manual');
});
const hasSelectionContentBoxes = computed(() => selectionContentBoxes.value.mixed
    || Object.keys(selectionContentBoxes.value.value ?? {}).length > 0);
const selectionContentBoxesLabel = computed(() => {
    if (selectionContentBoxes.value.mixed) {
        return t('scanCleanup.settings.mixed');
    }
    return hasSelectionContentBoxes.value
        ? t('scanCleanup.settings.manual')
        : t('scanCleanup.settings.automatic');
});
const applyScopeItems = computed(() => ([
    [
        'all',
        'allPages',
    ],
    [
        'from-here',
        'fromHere',
    ],
    [
        'selected',
        'selectedPages',
    ],
    [
        'every-other',
        'everyOther',
    ],
] as const).map(([
    scope,
    label,
]) => ({
    label: t(`scanCleanup.settings.applyScopes.${label}`),
    onSelect: () => applyLeaderOverrides(scope),
})));

function done() {
    emit('done');
}

function confirmResetPageOverrides() {
    resetPageOverrides();
    resetOverridesPopoverOpen.value = false;
}

function updateOutputMode(value: string) {
    settings.outputMode = value as TScanCleanupOutputMode;
}

function updateSettingsScope(value: string | number) {
    if (value === 'selection' && selectedPages.value.size > 0) {
        settingsScope.value = 'selection';
    } else if (value === 'document') {
        settingsScope.value = 'document';
    }
}

function handleSelectionLayout(value: string | number) {
    const layout = String(value) as TScanCleanupPageLayoutOverride;
    if (selectionLayoutItems.value.some(item => item.value === layout)) {
        updateSelectionLayoutOverride(layout);
    }
}

function handleSelectionRotation(value: string | number) {
    const rotation = Number(value) as TScanCleanupPageRotation;
    if ([
        0,
        90,
        180,
        270,
    ].includes(rotation)) {
        updateSelectionRotation(rotation);
    }
}

function handleSelectionInclusion(value: string | number) {
    if (value === 'included' || value === 'excluded') {
        updateSelectionExcluded(value === 'excluded');
    }
}

watch(() => selectedPages.value.size, (count) => {
    if (count === 0) settingsScope.value = 'document';
});
watch([
    previewPage,
    previewViewMode,
    previewZoomMode,
], ([
    page,
    viewMode,
    zoomMode,
]) => emit('update:session-state', {
    previewPage: page,
    previewViewMode: viewMode,
    previewZoomMode: zoomMode,
}), {immediate: true});
</script>

<style scoped>
.scan-cleanup-surface {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    background: var(--ui-bg);
}

.scan-cleanup-workspace {
    display: grid;
    min-height: 0;
    flex: 1;
    grid-template:
        'thumbnails preview settings' minmax(0, 1fr) / minmax(var(--app-scan-page-list-collapsed-width), var(--app-scan-page-list-width))
        minmax(0, 1fr)
        var(--app-scan-dialog-rail-width);
    overflow: hidden;
}

.scan-cleanup-options-rail {
    grid-area: settings;
    box-sizing: border-box;
    height: 100%;
    width: 100%;
    min-width: 0;
    min-height: 0;
    align-self: stretch;
    overflow: hidden auto;
    overscroll-behavior: contain;
    border: 0;
    border-inline-start: var(--app-hairline-height) solid var(--ui-border);
    padding: var(--app-space-9xl);
    padding-block-end: var(--app-space-12xl);
    mask-image: var(--app-scan-options-fade-mask);
}

.scan-thumbnail-rail {
    grid-area: thumbnails;
}

.scan-cleanup-preview-hero {
    grid-area: preview;
}

.scan-cleanup-options-rail:disabled {
    opacity: var(--app-scan-disabled-opacity);
}

.scan-cleanup-settings-tabs {
    width: 100%;
    margin-block-end: var(--app-space-5xl);
}

.scan-cleanup-settings-content {
    min-width: 0;
}

.scan-cleanup-selection-hint {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.scan-cleanup-lossless-explanation {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.scan-cleanup-option-group {
    display: grid;
    gap: var(--app-space-3xl);
    padding-block-end: var(--app-space-5xl);
}

.scan-cleanup-option-group + .scan-cleanup-option-group {
    border-block-start: var(--app-hairline-height) solid var(--ui-border);
    padding-block-start: var(--app-space-5xl);
}

.scan-cleanup-option-group h3 {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
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

.scan-cleanup-alignment-grid > * {
    justify-content: center;
}

.scan-cleanup-selection-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: var(--app-space-sm);
    padding-block-end: var(--app-space-5xl);
}

.scan-cleanup-selection-field {
    display: grid;
    gap: var(--app-space-sm);
}

.scan-cleanup-selection-field-label,
.scan-cleanup-selection-reset-row,
.scan-cleanup-selection-reset-row > div {
    display: flex;
    align-items: center;
    gap: var(--app-space-sm);
}

.scan-cleanup-selection-field-label,
.scan-cleanup-selection-reset-row {
    justify-content: space-between;
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
}

.scan-cleanup-selection-reset-row > div {
    min-width: 0;
    flex-wrap: wrap;
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

.scan-cleanup-reset-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--app-space-sm);
}

.scan-cleanup-reset-confirmation {
    display: grid;
    max-width: var(--app-scan-reset-confirmation-width);
    gap: var(--app-space-5xl);
    padding: var(--app-space-9xl);
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
}

.scan-cleanup-reset-confirmation > span {
    color: var(--ui-text-muted);
}
</style>
