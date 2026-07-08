<template>
    <AppTooltip
        usefulness="always"
        :delay-duration="150"
        class="ocr-setting-help"
    >
        <button
            type="button"
            class="ocr-setting-help-trigger"
            :aria-label="triggerLabel"
            @click.stop.prevent
        >
            <UIcon name="i-ph-info" class="ocr-setting-help-icon" />
        </button>

        <template #content>
            <dl class="ocr-setting-help-options">
                <div
                    v-for="option in options"
                    :key="option.label"
                    class="ocr-setting-help-option"
                >
                    <dt class="ocr-setting-help-term">{{ option.label }}</dt>
                    <dd class="ocr-setting-help-description">{{ option.description }}</dd>
                </div>
            </dl>
        </template>
    </AppTooltip>
</template>

<script setup lang="ts">
interface IOcrSettingHelpOption {
    label: string;
    description: string;
}

interface IProps {
    triggerLabel: string;
    options: IOcrSettingHelpOption[];
}

const {
    triggerLabel,
    options,
} = defineProps<IProps>();
</script>

<style scoped>
.ocr-setting-help-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    border-radius: var(--app-radius-xs);
    background: transparent;
    color: var(--ui-text-dimmed);
    line-height: 0;
    cursor: help;
    transition: color 0.1s ease;
}

.ocr-setting-help-trigger:hover,
.ocr-setting-help-trigger:focus-visible {
    color: var(--ui-text-muted);
}

.ocr-setting-help-trigger:focus {
    outline: none;
}

.ocr-setting-help-trigger:focus-visible {
    box-shadow: 0 0 0 2px var(--app-toolbar-focus-ring);
}

.ocr-setting-help-icon {
    width: 0.8125rem;
    height: 0.8125rem;
}

.ocr-setting-help-options {
    display: flex;
    flex-direction: column;
    gap: var(--app-space-3xl);
    text-transform: none;
    letter-spacing: normal;
}

.ocr-setting-help-option {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
}

.ocr-setting-help-term {
    font-size: var(--app-text-size-kicker);
    font-weight: var(--app-font-weight-semibold);
    color: var(--ui-text-highlighted);
}

.ocr-setting-help-description {
    font-size: var(--app-text-size-kicker);
    line-height: var(--app-line-height-text);
    color: var(--ui-text-muted);
}
</style>
