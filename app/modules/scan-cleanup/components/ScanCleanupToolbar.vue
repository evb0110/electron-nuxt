<template>
    <div class="scan-cleanup-toolbar-stack">
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
                        :disabled="isRunning"
                        @click="emit('update:zoneEditing', !zoneEditing)"
                    />
                </AppTooltip>
                <ol class="scan-cleanup-stepper" :aria-label="t('scanCleanup.steps.label')">
                    <li
                        v-for="step in steps"
                        :key="step.number"
                        class="scan-cleanup-step"
                        :class="{
                            'is-active': step.number === activeStep,
                            'is-complete': step.number < activeStep,
                        }"
                        :aria-current="step.number === activeStep ? 'step' : undefined"
                    >
                        <span class="scan-cleanup-step-number" aria-hidden="true">
                            {{ step.number < activeStep ? '✓' : step.number }}
                        </span>
                        <span>{{ step.label }}</span>
                    </li>
                </ol>
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
                    <template v-if="isRunning">
                        <span
                            class="scan-cleanup-toolbar-count"
                            role="status"
                            aria-live="polite"
                            :aria-label="progressText"
                        >{{ processedCount }} / {{ cleanupTotal }}</span>
                    </template>
                    <template v-else-if="isDetecting">
                        <span
                            class="scan-cleanup-toolbar-count"
                            role="status"
                            aria-live="polite"
                            :aria-label="t('scanCleanup.detectAll.progressAria', {
                                detected: detectionDetected,
                                total: detectionTotal,
                            })"
                        >{{ detectionDetected }} / {{ detectionTotal }}</span>
                        <UButton
                            class="scan-cleanup-toolbar-cancel-detection"
                            type="button"
                            color="neutral"
                            variant="ghost"
                            size="xs"
                            square
                            :icon="detectionCancelRequested ? 'i-ph-circle-notch' : 'i-ph-x'"
                            :aria-label="detectionCancelRequested
                                ? t('scanCleanup.detectAll.canceling')
                                : t('scanCleanup.detectAll.cancel')"
                            :disabled="detectionCancelRequested"
                            @click="emit('cancel-detection')"
                        />
                    </template>
                    <span v-else-if="detectionError" class="scan-cleanup-toolbar-error" role="alert">
                        {{ detectionError }}
                    </span>
                    <span v-else-if="outputEstimate" class="scan-cleanup-toolbar-estimate">
                        {{ outputEstimate }}
                    </span>
                    <span v-else class="scan-cleanup-toolbar-status-placeholder" aria-hidden="true">&nbsp;</span>
                </div>
            </div>

            <div class="scan-cleanup-toolbar-zone scan-cleanup-toolbar-zone-right">
                <UCheckbox
                    :model-value="runOcrAfterCleanup"
                    :label="t('scanCleanup.runOcrAfterCleanup')"
                    :disabled="isRunning"
                    @update:model-value="updateRunOcrAfterCleanup"
                />
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
                    <UButton
                        v-else
                        class="scan-cleanup-toolbar-primary-action"
                        type="button"
                        color="primary"
                        size="sm"
                        icon="i-ph-play"
                        :label="t('scanCleanup.cleanUp')"
                        :disabled="!canRun"
                        @click="emit('run')"
                    />
                </div>
            </div>
        </header>
        <div
            v-if="isRunning"
            class="scan-cleanup-toolbar-progress"
            role="progressbar"
            :aria-label="progressText"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="normalizedPercent"
        >
            <span :style="{width: `${normalizedPercent}%`}" />
        </div>
    </div>
</template>

<script setup lang="ts">
const {
    canDetectAll,
    canRun,
    cancelRequested,
    cleanupTotal,
    detectionCancelRequested,
    detectionDetected,
    detectionError,
    detectionTotal,
    isDetecting,
    isRunning,
    outputEstimate,
    percent,
    processedCount,
    progressText,
    runOcrAfterCleanup,
    zoneEditing,
} = defineProps<{
    canDetectAll: boolean;
    canRun: boolean;
    cancelRequested: boolean;
    cleanupTotal: number;
    detectionCancelRequested: boolean;
    detectionDetected: number;
    detectionError: string;
    detectionTotal: number;
    isDetecting: boolean;
    isRunning: boolean;
    outputEstimate: string;
    percent: number;
    processedCount: number;
    progressText: string;
    runOcrAfterCleanup: boolean;
    zoneEditing?: boolean;
}>();
const emit = defineEmits<{
    cancel: [];
    'cancel-detection': [];
    'detect-all': [];
    done: [];
    run: [];
    'update:runOcrAfterCleanup': [value: boolean];
    'update:zoneEditing': [value: boolean];
}>();
const {t} = useTypedI18n();
const normalizedPercent = computed(() => Math.min(100, Math.max(0, Math.round(percent))));
const activeStep = computed<1 | 2 | 3>(() => isRunning ? 3 : isDetecting || detectionError ? 1 : 2);
const steps = computed(() => [
    {
        number: 1 as const,
        label: t('scanCleanup.steps.detect'),
    },
    {
        number: 2 as const,
        label: t('scanCleanup.steps.review'),
    },
    {
        number: 3 as const,
        label: t('scanCleanup.steps.cleanUp'),
    },
]);

function updateRunOcrAfterCleanup(value: boolean | 'indeterminate') {
    emit('update:runOcrAfterCleanup', value === true);
}
</script>

<style scoped>
.scan-cleanup-toolbar-stack {
    position: relative;
    display: flex;
    min-width: 0;
    flex-direction: column;
}

.scan-cleanup-toolbar {
    display: grid;
    grid-template-columns:
        var(--app-scan-toolbar-left-zone-width)
        minmax(0, 1fr)
        var(--app-scan-toolbar-right-zone-width);
    gap: var(--app-space-7xl);
    overflow: hidden;
    padding: var(--app-space-3xl) var(--app-space-7xl);
}

.scan-cleanup-toolbar-zone,
.scan-cleanup-stepper,
.scan-cleanup-step,
.scan-cleanup-toolbar-status-slot,
.scan-cleanup-toolbar-primary-slot {
    display: flex;
    min-width: 0;
    align-items: center;
}

.scan-cleanup-toolbar-zone-left {
    width: var(--app-scan-toolbar-left-zone-width);
    gap: var(--app-space-5xl);
    overflow: hidden;
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
    min-width: 0;
    overflow: hidden;
    color: var(--ui-text-highlighted);
    font-size: var(--app-text-size-body);
    font-weight: var(--app-font-weight-heading);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.scan-cleanup-stepper {
    width: var(--app-scan-toolbar-stepper-width);
    flex: none;
    justify-content: center;
    gap: var(--app-space-3xl);
    color: var(--ui-text-dimmed);
    font-size: var(--app-text-size-kicker);
    white-space: nowrap;
}

.scan-cleanup-step {
    gap: var(--app-space-sm);
}

.scan-cleanup-step + .scan-cleanup-step::before {
    margin-inline-end: var(--app-space-sm);
    color: var(--ui-border);
    content: '·';
}

.scan-cleanup-step.is-active {
    color: var(--ui-text);
    font-weight: var(--app-font-weight-heading);
}

.scan-cleanup-step.is-complete {
    color: var(--ui-text-muted);
}

.scan-cleanup-step-number {
    font-variant-numeric: tabular-nums;
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

.scan-cleanup-toolbar-progress {
    position: absolute;
    inset-block-end: 0;
    inset-inline: 0;
    height: var(--app-scan-toolbar-progress-height);
    overflow: hidden;
    background: var(--ui-bg-muted);
}

.scan-cleanup-toolbar-progress > span {
    display: block;
    height: 100%;
    background: var(--ui-primary);
    transition: width var(--app-transition-standard);
}
</style>
