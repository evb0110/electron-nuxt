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
            :detection-detected="detectionProgress.completedUnits"
            :detection-error="detectionError"
            :detection-total="detectionProgress.totalUnits"
            :is-detecting="detectionPending"
            :is-running="isRunning"
            :output-estimate="outputEstimate"
            :percent="jobProgress.percent"
            :processed-count="jobProgress.completedUnits"
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
        :aria-label="t('scanCleanup.workspaceTitle')"
    >
        <div
            class="scan-cleanup-workspace"
            :aria-busy="isRunning"
        >
            <fieldset class="scan-cleanup-options-rail app-scrollbar app-scroll-region--balanced" :disabled="isRunning">
                <ScanCleanupSettingsPanel
                    :alignment-items="alignmentItems"
                    :apply-scope-items="applyScopeItems"
                    :content-boxes="scopeContentBoxes"
                    :excluded="scopeExcluded"
                    :has-scope-overrides="hasScopeOverrides"
                    :highlighted-scope="highlightedScope"
                    :inclusion-items="scopeInclusionItems"
                    :inline-error="inlineError"
                    :layout="scopeLayout"
                    :layout-items="scopeLayoutItems"
                    :manual-split="scopeManualSplit"
                    :margins="scopeMargins"
                    :margins-linked="scopeMarginsLinked"
                    :output-items="outputItems"
                    :override-counts="scopeOverrideCounts"
                    :page-number="selectionLeader"
                    :placement-alignment="scopePlacementAlignment"
                    :reading-order-items="readingOrderItems"
                    :rotation="scopeRotation"
                    :rotation-items="scopeRotationItems"
                    :scope="settingsScope"
                    :selected-count="selectedPages.size"
                    :settings="settings"
                    :thickness-label="thicknessLabel"
                    :total-pages="previewTotalPages"
                    @reset-content-boxes="resetScopeContentBoxes"
                    @reset-control-override="resetScopeControlOverride"
                    @reset-manual-split="resetScopeManualSplit"
                    @reset-scope-overrides="resetScopeOverrides"
                    @thickness-input="handleThicknessInput"
                    @update-inclusion="handleScopeInclusion"
                    @update-layout="handleScopeLayout"
                    @update-margin="updateScopeMargin"
                    @update:margins-linked="setScopeMarginsLinked"
                    @update-placement="updateScopePlacement"
                    @update-rotation="handleScopeRotation"
                    @update-setting="updateDocumentSetting"
                    @update:scope="setSettingsScope"
                />
            </fieldset>

            <ScanCleanupThumbnailRail
                :source="pageSource"
                :source-pending="pageSourcePending"
                :total-pages="previewTotalPages"
                :selection-leader="selectionLeader"
                :selected-pages="selectedPages"
                :overrides="settings.pageOverrides"
                :classifications="authoritativeLayoutByPage"
                :confidences="detectedLayoutConfidenceByPage"
                :text-axes="detectedTextAxisByPage"
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
                    :source="pageSource"
                    :layout-classification="authoritativeLayoutByPage.get(previewPage)"
                    :rotation-degrees="currentPageOverride.rotationDegrees"
                    :view-mode="previewViewMode"
                    :match-page-size="settings.matchPageSize"
                    :alignment="settings.pageAlignment"
                    :page-number="previewPage"
                    :total-pages="previewTotalPages"
                    :stale-page="previewResult !== null && previewResult.pageNumber !== previewPage"
                    :manual-split="currentPageOverride.manualSplit"
                    :reading-order="settings.readingOrder"
                    :manual-content-boxes="currentPageOverride.manualContentBoxes ?? {}"
                    :placement-overrides="currentPageOverride.placementOverrides ?? {}"
                    :lossless="settings.preserveOriginalQuality === true"
                    :show-first-run-guidance="showFirstRunGuidance"
                    @previous="navigatePreview(-1)"
                    @next="navigatePreview(1)"
                    @retry="retryPreview"
                    @update:view-mode="previewViewMode = $event"
                    @update:manual-split="updateCurrentManualSplit"
                    @update:manual-content-box="updateCurrentManualContentBox"
                    @update:placement="updateCurrentPlacement"
                    @dismiss-first-run-guidance="dismissFirstRunGuidance"
                />
            </div>
        </div>

    </section>
</template>

<script setup lang="ts">
import type {TDocumentRef} from '@contracts/documentRef';
import type {
    IScanCleanupOptions,
    TScanCleanupPageLayoutOverride,
    TScanCleanupPageRotation,
} from '@contracts/electronApiScanCleanup';
import {
    areScanCleanupMarginsMmEqual,
    DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE,
    getScanCleanupPageOverride,
    resolveScanCleanupMarginsMm,
    resolveScanCleanupOutputPlacement,
    resolveScanCleanupPageLayout,
} from '@contracts/scanCleanupPageOverrides';
import type {IDocumentPageSource} from '@app/utils/document-viewer/source/documentPageSource';
import type {IScanCleanupTabSessionState} from '@app/modules/workspace-shell/public';
import ScanCleanupPreviewPane from '@app/modules/scan-cleanup/components/preview/PreviewShell.vue';
import ScanCleanupThumbnailRail from '@app/modules/scan-cleanup/components/ScanCleanupThumbnailRail.vue';
import ScanCleanupToolbar from '@app/modules/scan-cleanup/components/ScanCleanupToolbar.vue';
import ScanCleanupSettingsPanel from '@app/modules/scan-cleanup/components/settings/ScanCleanupSettingsPanel.vue';
import type {TScanCleanupOverrideControl} from '@app/modules/scan-cleanup/composables/useScanCleanupSelection';
import {useScanCleanupWorkspaceSession} from '@app/modules/scan-cleanup/composables/useScanCleanupWorkspaceSession';
import {resolveScanCleanupMixedValue} from '@app/modules/scan-cleanup/runtime/scanCleanupSelectionOverrides';

const { t } = useTypedI18n();
const {
    sourcePath,
    currentPage = 1,
    totalPages = 1,
    documentKey = null,
    documentRevision = null,
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
    documentRevision?: string | null;
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
const workspaceSession = useScanCleanupWorkspaceSession({
    active: () => true,
    sourcePath: () => sourcePath,
    documentKey: () => documentKey,
    documentRevision: () => documentRevision,
    ownerId: () => sessionState?.ownerId,
    currentPage: () => currentPage,
    totalPages: () => totalPages,
    initialPreviewPage: () => sessionState?.previewPage,
    initialPreviewViewMode: () => sessionState?.previewViewMode,
});
const {
    alignmentItems,
    handleThicknessInput,
    layoutItems,
    marginsLinked: documentMarginsLinked,
    setMarginsLinked: setDocumentMarginsLinked,
    outputItems,
    readingOrderItems,
    resetPageOverrides,
    runOcrAfterCleanup,
    showFirstRunGuidance,
    dismissFirstRunGuidance,
    thicknessLabel,
    updateMargin: updateDocumentMargin,
    values: settings,
} = workspaceSession.settings;
const {
    applyLeaderOverrides,
    currentPageOverride,
    highlightedScope,
    leader: selectionLeader,
    marginsLinked: selectionMarginsLinked,
    setMarginsLinked: setSelectionMarginsLinked,
    resetContentBoxes,
    resetControlOverride,
    resetManualSplit,
    resetOverrides,
    selectedPages,
    selectPage,
    setSettingsScope,
    settingsScope,
    updateCurrentManualContentBox,
    updateCurrentManualSplit,
    updateCurrentPlacementAll,
    updatePageOverride,
    updatePlacement: updateSelectionPlacement,
    updateRotation: updateSelectionRotation,
    updateExcluded: updateSelectionExcluded,
    updateLayoutOverride: updateSelectionLayoutOverride,
    updateMargins: updateSelectionMargins,
    updateCurrentPlacement,
} = workspaceSession.selection;
const previewPage = selectionLeader;
const {
    authoritativeLayoutByPage,
    canDetectAll,
    cancel: cancelDetection,
    cancelRequested: detectionCancelRequested,
    confidenceByPage: detectedLayoutConfidenceByPage,
    detectAllPages,
    error: detectionError,
    outputEstimate,
    pending: detectionPending,
    progress: detectionProgress,
    textAxisByPage: detectedTextAxisByPage,
} = workspaceSession.detection;
const {
    error: previewError,
    loading: previewLoading,
    navigate: navigatePreview,
    result: previewResult,
    retry: retryPreview,
    totalPages: previewTotalPages,
    viewMode: previewViewMode,
} = workspaceSession.preview;
const {
    cancel,
    cancelRequested,
    canRun,
    inlineError,
    isRunning,
    ownerId,
    processedPages,
    progress: jobProgress,
    progressText,
    run,
} = workspaceSession.run;
const allScopeRotation = ref<TScanCleanupPageRotation>(0);
const allScopeExcluded = ref(false);
const cleanupProgressTotal = computed(() => Math.max(jobProgress.value.totalUnits, previewTotalPages.value));
const allPageNumbers = computed(() => Array.from(
    {length: Math.max(1, previewTotalPages.value)},
    (_, index) => index + 1,
));
const scopePageNumbers = computed(() => settingsScope.value === 'all'
    ? allPageNumbers.value
    : settingsScope.value === 'page'
        ? [selectionLeader.value]
        : [...selectedPages.value].sort((left, right) => left - right));
const scopePageOverrides = computed(() => scopePageNumbers.value
    .map(page => getScanCleanupPageOverride(settings.pageOverrides, page)));
const scopeLayout = computed(() => settingsScope.value === 'all'
    ? resolveScanCleanupMixedValue([settings.layoutMode])
    : resolveScanCleanupMixedValue(scopePageOverrides.value.map(override => override.layoutOverride)));
const scopeRotation = computed(() => settingsScope.value === 'all'
    ? resolveScanCleanupMixedValue([allScopeRotation.value])
    : resolveScanCleanupMixedValue(scopePageOverrides.value.map(override => override.rotationDegrees)));
const scopeExcluded = computed(() => settingsScope.value === 'all'
    ? resolveScanCleanupMixedValue([allScopeExcluded.value])
    : resolveScanCleanupMixedValue(scopePageOverrides.value.map(override => override.excluded)));
const scopeManualSplit = computed(() => resolveScanCleanupMixedValue(
    scopePageOverrides.value.map(override => override.manualSplit),
));
const scopeContentBoxes = computed(() => resolveScanCleanupMixedValue(
    scopePageOverrides.value.map(override => override.manualContentBoxes ?? {}),
));
const scopeMargins = computed(() => settingsScope.value === 'all'
    ? resolveScanCleanupMixedValue([settings.marginsMm])
    : resolveScanCleanupMixedValue(scopePageOverrides.value
        .map(override => resolveScanCleanupMarginsMm(settings.marginsMm, override))));
const scopePlacementAlignment = computed(() => settingsScope.value === 'all'
    ? resolveScanCleanupMixedValue([settings.pageAlignment])
    : resolveScanCleanupMixedValue(scopePageOverrides.value.flatMap(override => ([
        'full',
        'left',
        'right',
    ] as const).map(half => resolveScanCleanupOutputPlacement(settings.pageAlignment, override, half)))));
const scopeMarginsLinked = computed(() => settingsScope.value === 'all'
    ? documentMarginsLinked.value
    : selectionMarginsLinked.value);
const scopeOverrideCounts = computed(() => {
    const counts = {
        inclusion: 0,
        layout: 0,
        margins: 0,
        placement: 0,
        rotation: 0,
    };
    for (const page of scopePageNumbers.value) {
        const override = getScanCleanupPageOverride(settings.pageOverrides, page);
        if (resolveScanCleanupPageLayout(settings.layoutMode, override.layoutOverride) !== settings.layoutMode) {
            counts.layout += 1;
        }
        if (override.rotationDegrees !== DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.rotationDegrees) {
            counts.rotation += 1;
        }
        if (override.excluded !== DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.excluded) {
            counts.inclusion += 1;
        }
        if (override.marginsMm && !areScanCleanupMarginsMmEqual(override.marginsMm, settings.marginsMm)) {
            counts.margins += 1;
        }
        if (Object.values(override.placementOverrides ?? {})
            .some(alignment => alignment !== settings.pageAlignment)) {
            counts.placement += 1;
        }
    }
    return counts;
});
const hasScopeOverrides = computed(() => {
    if (settingsScope.value === 'all') {
        return Object.keys(settings.pageOverrides).length > 0;
    }
    return scopePageNumbers.value.some(page => settings.pageOverrides[String(page)] !== undefined);
});
const scopeLayoutItems = computed(() => settingsScope.value === 'all'
    ? layoutItems.value
    : [
        ...(scopeLayout.value.mixed ? [{
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
const scopeRotationItems = computed(() => [
    ...(scopeRotation.value.mixed ? [{
        value: 'mixed' as const,
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
const scopeInclusionItems = computed(() => [
    ...(scopeExcluded.value.mixed ? [{
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
        'every-other',
        'everyOther',
    ],
    ...(selectedPages.value.size >= 2 ? [[
        'selected',
        'selectedPages',
    ] as const] : []),
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

function updateDocumentSetting(
    key: keyof IScanCleanupOptions,
    value: IScanCleanupOptions[keyof IScanCleanupOptions],
) {
    Object.assign(settings, {[key]: value});
}

function handleScopeLayout(value: string | number) {
    if (settingsScope.value === 'all') {
        if ([
            'auto',
            'force-single',
            'force-two-page',
        ].includes(String(value))) {
            const layoutMode = String(value) as IScanCleanupOptions['layoutMode'];
            settings.layoutMode = layoutMode;
            const matchingOverride = layoutMode === 'force-single'
                ? 'single'
                : layoutMode === 'force-two-page' ? 'spread' : 'auto';
            const matchingPages = Object.keys(settings.pageOverrides)
                .map(Number)
                .filter(page => getScanCleanupPageOverride(settings.pageOverrides, page).layoutOverride === matchingOverride);
            updateSelectionLayoutOverride('auto', matchingPages);
        }
        return;
    }
    const layout = String(value) as TScanCleanupPageLayoutOverride;
    if (scopeLayoutItems.value.some(item => item.value === layout && !('disabled' in item && item.disabled === true))) {
        updateSelectionLayoutOverride(layout, scopePageNumbers.value);
    }
}

function handleScopeRotation(value: string | number) {
    const rotation = Number(value) as TScanCleanupPageRotation;
    if ([
        0,
        90,
        180,
        270,
    ].includes(rotation)) {
        if (settingsScope.value === 'all') {
            allScopeRotation.value = rotation;
        }
        updateSelectionRotation(rotation, scopePageNumbers.value);
    }
}

function handleScopeInclusion(value: string | number) {
    if (value === 'included' || value === 'excluded') {
        const excluded = value === 'excluded';
        if (settingsScope.value === 'all') {
            allScopeExcluded.value = excluded;
        }
        updateSelectionExcluded(excluded, scopePageNumbers.value);
    }
}

function updateScopeMargin(target: Parameters<typeof updateDocumentMargin>[0], value: number) {
    if (settingsScope.value === 'all') {
        updateDocumentMargin(target, value);
        return;
    }
    updateSelectionMargins(target, value, scopePageNumbers.value);
}

function setScopeMarginsLinked(linked: boolean) {
    if (settingsScope.value === 'all') {
        setDocumentMarginsLinked(linked);
        return;
    }
    setSelectionMarginsLinked(linked, scopePageNumbers.value, scopeMargins.value.value);
}

function updateScopePlacement(value: Parameters<typeof updateCurrentPlacementAll>[0]) {
    if (settingsScope.value === 'all') {
        updateCurrentPlacementAll(value);
        return;
    }
    updateSelectionPlacement(value, scopePageNumbers.value);
}

function resetScopeManualSplit() {
    resetManualSplit(scopePageNumbers.value);
}

function resetScopeContentBoxes() {
    resetContentBoxes(scopePageNumbers.value);
}

function resetScopeControlOverride(control: TScanCleanupOverrideControl) {
    resetControlOverride(control, scopePageNumbers.value);
}

function resetScopeOverrides() {
    if (settingsScope.value === 'all') {
        resetPageOverrides();
        allScopeRotation.value = 0;
        allScopeExcluded.value = false;
        return;
    }
    resetOverrides(scopePageNumbers.value);
}

watch([
    previewPage,
    previewViewMode,
], ([
    page,
    viewMode,
]) => emit('update:session-state', {
    ownerId,
    previewPage: page,
    previewViewMode: viewMode,
}), {immediate: true});
</script>

<style>
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
    overflow: hidden;
    overscroll-behavior: contain;
    border: 0;
    border-inline-start: var(--app-hairline-height) solid var(--ui-border);
    padding: 0;
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

.scan-cleanup-selection-field {
    display: grid;
    gap: var(--app-space-sm);
}

.scan-cleanup-margins-control {
    display: grid;
    gap: var(--app-space-3xl);
}

.scan-cleanup-margins-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--app-space-sm);
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
}

.scan-cleanup-margins-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--app-space-3xl);
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

.scan-cleanup-details-trigger:focus-visible {
    outline: var(--app-hairline-height) solid var(--ui-primary);
    outline-offset: var(--app-space-xs);
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
