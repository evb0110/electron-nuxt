<template>
    <header
        class="toolbar scan-cleanup-toolbar"
        :aria-label="t('scanCleanup.workspaceTitle')"
    >
        <div class="scan-cleanup-toolbar-zone scan-cleanup-toolbar-zone-left">
            <UButton
                class="scan-cleanup-toolbar-done"
                type="button"
                color="neutral"
                variant="ghost"
                size="sm"
                icon="i-ph-caret-left"
                :label="t('scanCleanup.done')"
                @click="emit('done')"
            />
            <AppTooltip :text="t('scanCleanup.description')" usefulness="always">
                <h2 class="scan-cleanup-toolbar-title">{{ t('scanCleanup.workspaceTitle') }}</h2>
            </AppTooltip>
        </div>

        <div class="scan-cleanup-toolbar-zone scan-cleanup-toolbar-zone-center">
            <div
                v-if="isRunning"
                class="scan-cleanup-run-meter"
                role="progressbar"
                :aria-label="t('scanCleanup.runStatusLabel')"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuenow="normalizedPercent"
                :aria-valuetext="progressText"
            >
                <p class="scan-cleanup-run-meter-head">
                    <span
                        class="scan-cleanup-run-meter-phase"
                        role="status"
                        aria-live="polite"
                    >{{ transitionText || progressPhaseText }}</span>
                    <span
                        v-if="progressCountText"
                        class="scan-cleanup-run-meter-count"
                    >{{ progressCountText }}</span>
                    <span class="scan-cleanup-run-meter-percent">{{ progressPercentText }}</span>
                </p>
                <span class="scan-cleanup-run-meter-track">
                    <span
                        class="scan-cleanup-run-meter-fill"
                        :style="{width: `${normalizedPercent}%`}"
                    />
                </span>
            </div>
            <template v-else>
                <AppTooltip :text="t('scanCleanup.zones.toggleHint')">
                    <UButton
                        class="scan-cleanup-toolbar-zone-editor"
                        type="button"
                        :color="zoneEditing ? 'primary' : 'neutral'"
                        :variant="zoneEditing ? 'soft' : 'ghost'"
                        size="xs"
                        square
                        icon="i-ph-bounding-box"
                        :aria-label="t('scanCleanup.zones.toggle')"
                        :aria-pressed="zoneEditing"
                        @click="emit('update:zoneEditing', !zoneEditing)"
                    />
                </AppTooltip>
                <AppTooltip :text="t('scanCleanup.detectAll.redetect')">
                    <UButton
                        class="scan-cleanup-toolbar-redetect"
                        type="button"
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        icon="i-ph-arrows-clockwise"
                        :label="t('scanCleanup.detectAll.redetect')"
                        :aria-label="t('scanCleanup.detectAll.redetect')"
                        :disabled="!canDetectAll || isDetecting"
                        @click="emit('detect-all')"
                    />
                </AppTooltip>
                <div class="scan-cleanup-toolbar-status-slot">
                    <template v-if="isDetecting">
                        <ScanCleanupStableWidthText
                            class="scan-cleanup-toolbar-count"
                            role="status"
                            aria-live="polite"
                            :aria-label="detectionProgressText"
                            :text="detectionProgressText"
                            :widest="detectionProgressWidestText"
                        />
                        <AppTooltip :text="detectionCancelLabel" usefulness="always">
                            <UButton
                                class="scan-cleanup-toolbar-cancel-detection"
                                type="button"
                                color="neutral"
                                variant="ghost"
                                size="xs"
                                square
                                :icon="detectionCancelRequested ? 'i-ph-circle-notch' : 'i-ph-x'"
                                :aria-label="detectionCancelLabel"
                                :disabled="detectionCancelRequested"
                                @click="emit('cancel-detection')"
                            />
                        </AppTooltip>
                    </template>
                    <span v-else-if="detectionError" class="scan-cleanup-toolbar-error" role="alert">
                        {{ detectionError }}
                    </span>
                    <span v-else-if="outputEstimate" class="scan-cleanup-toolbar-estimate">
                        {{ outputEstimate }}
                    </span>
                    <span v-else class="scan-cleanup-toolbar-status-placeholder" aria-hidden="true">&nbsp;</span>
                </div>
            </template>
        </div>

        <div class="scan-cleanup-toolbar-zone scan-cleanup-toolbar-zone-right">
            <div class="scan-cleanup-toolbar-primary-slot">
                <UButton
                    v-if="isRunning"
                    class="scan-cleanup-toolbar-primary-action"
                    type="button"
                    color="neutral"
                    variant="outline"
                    size="sm"
                    :label="cancelRequested ? t('scanCleanup.canceling') : t('scanCleanup.cancel')"
                    :disabled="cancelRequested"
                    @click="emit('cancel')"
                />
                <AppTooltip
                    v-else
                    :text="runDisabledReason || runLabel"
                    usefulness="always"
                >
                    <UButton
                        class="scan-cleanup-toolbar-primary-action"
                        type="button"
                        color="primary"
                        size="sm"
                        icon="i-ph-play"
                        :label="runLabel"
                        :disabled="!canRun"
                        @click="emit('run')"
                    />
                </AppTooltip>
            </div>
        </div>
    </header>
</template>

<script setup lang="ts">
import ScanCleanupStableWidthText from '@app/modules/scan-cleanup/components/ScanCleanupStableWidthText.vue';

const {
    canDetectAll,
    canRun,
    cancelRequested,
    detectionCancelRequested,
    detectionError,
    detectionProgressText,
    detectionProgressWidestText,
    isDetecting,
    isRunning,
    outputEstimate,
    percent,
    progressCountText,
    progressPercentText,
    progressPhaseText,
    progressText,
    runLabel,
    runDisabledReason,
    zoneEditing,
    transitionText,
} = defineProps<{
    canDetectAll: boolean;
    canRun: boolean;
    cancelRequested: boolean;
    detectionCancelRequested: boolean;
    detectionError: string;
    detectionProgressText: string;
    detectionProgressWidestText: string;
    isDetecting: boolean;
    isRunning: boolean;
    outputEstimate: string;
    percent: number;
    progressCountText: string;
    progressPercentText: string;
    progressPhaseText: string;
    progressText: string;
    runLabel: string;
    runDisabledReason: string;
    zoneEditing?: boolean;
    transitionText: string;
}>();
const emit = defineEmits<{
    cancel: [];
    'cancel-detection': [];
    'detect-all': [];
    done: [];
    run: [];
    'update:zoneEditing': [value: boolean];
}>();
const {t} = useTypedI18n();
const normalizedPercent = computed(() => Math.min(100, Math.max(0, Math.round(percent))));
// Cancelling detection is not destructive: pages already detected keep their
// results, so the control names that outcome instead of a bare “Cancel”.
const detectionCancelLabel = computed(() => t(detectionCancelRequested
    ? 'scanCleanup.detectAll.canceling'
    : 'scanCleanup.detectAll.cancelDetection'));
</script>

<style scoped>
.scan-cleanup-toolbar {
    display: grid;
    grid-template-columns:
        auto
        minmax(0, 1fr)
        var(--app-scan-toolbar-right-zone-width);
    gap: var(--app-space-7xl);
    overflow: hidden;
    padding: var(--app-space-3xl) var(--app-space-7xl);
}

.scan-cleanup-toolbar-zone,
.scan-cleanup-toolbar-status-slot,
.scan-cleanup-toolbar-primary-slot {
    display: flex;
    min-width: 0;
    align-items: center;
}

.scan-cleanup-toolbar-zone-left {
    gap: var(--app-space-5xl);
}

.scan-cleanup-toolbar-zone-center {
    justify-content: center;
    gap: var(--app-space-5xl);
    overflow: hidden;
}

.scan-cleanup-toolbar-zone-right {
    width: var(--app-scan-toolbar-right-zone-width);
    justify-content: flex-end;
    gap: var(--app-space-7xl);
}

.scan-cleanup-toolbar-done {
    flex: none;
}

.scan-cleanup-toolbar-title {
    flex: none;
    color: var(--ui-text-highlighted);
    font-size: var(--app-text-size-body);
    font-weight: var(--app-font-weight-heading);
    white-space: nowrap;
}

.scan-cleanup-run-meter {
    display: flex;
    width: min(100%, var(--app-scan-toolbar-meter-width));
    flex-direction: column;
    gap: var(--app-space-sm);
}

.scan-cleanup-run-meter-head {
    display: flex;
    align-items: baseline;
    gap: var(--app-space-3xl);
    font-size: var(--app-text-size-body-sm);
    white-space: nowrap;
}

.scan-cleanup-run-meter-phase {
    min-width: 0;
    overflow: hidden;
    color: var(--ui-text-highlighted);
    font-weight: var(--app-font-weight-heading);
    text-overflow: ellipsis;
}

.scan-cleanup-run-meter-count {
    color: var(--ui-text-muted);
    font-variant-numeric: tabular-nums;
}

.scan-cleanup-run-meter-percent {
    margin-inline-start: auto;
    color: var(--ui-text-muted);
    font-variant-numeric: tabular-nums;
}

.scan-cleanup-run-meter-track {
    display: block;
    overflow: hidden;
    width: 100%;
    height: var(--app-scan-toolbar-progress-height);
    border-radius: var(--app-radius-full);
    background: var(--ui-bg-muted);
}

.scan-cleanup-run-meter-fill {
    display: block;
    height: 100%;
    background: var(--ui-primary);
    transition: width var(--app-transition-standard);
}

.scan-cleanup-toolbar-redetect {
    width: var(--app-scan-toolbar-redetect-width);
    flex: none;
    justify-content: center;
}

.scan-cleanup-toolbar-status-slot {
    width: var(--app-scan-toolbar-status-width);
    min-width: var(--app-scan-toolbar-status-width);
    flex: none;
    justify-content: flex-start;
    gap: var(--app-space-sm);
    overflow: hidden;
}

.scan-cleanup-toolbar-primary-slot {
    width: var(--app-scan-toolbar-primary-width);
    min-width: var(--app-scan-toolbar-primary-width);
}

.scan-cleanup-toolbar-primary-action {
    width: 100%;
    justify-content: center;
}

.scan-cleanup-toolbar-count {
    flex: none;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body-sm);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}

.scan-cleanup-toolbar-estimate,
.scan-cleanup-toolbar-error,
.scan-cleanup-toolbar-status-placeholder {
    min-width: 0;
    overflow: hidden;
    font-size: var(--app-text-size-body-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.scan-cleanup-toolbar-estimate,
.scan-cleanup-toolbar-status-placeholder {
    color: var(--ui-text-muted);
}

.scan-cleanup-toolbar-error {
    color: var(--ui-error);
}
</style>
