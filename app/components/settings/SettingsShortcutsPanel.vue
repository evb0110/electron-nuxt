<template>
    <details class="settings-details flex flex-col">
        <summary class="settings-legend is-toggle">
            {{ t('settings.shortcuts') }}
        </summary>
        <p class="settings-hint">
            {{ description }}
        </p>
        <div class="flex flex-col">
            <div
                v-for="item in items"
                :key="item.label"
                class="settings-shortcut-row flex items-center justify-between gap-3"
            >
                <span class="settings-shortcut-label">{{ item.label }}</span>
                <span class="settings-shortcut-keys flex shrink-0">
                    <kbd
                        v-for="(part, i) in item.keys"
                        :key="i"
                        class="settings-kbd"
                    >{{ part }}</kbd>
                </span>
            </div>
        </div>
    </details>
</template>

<script setup lang="ts">
export interface ISettingsShortcutItem {
    label: string;
    keys: string[];
}

defineProps<{
    description: string;
    items: ISettingsShortcutItem[];
}>();

const { t } = useTypedI18n();
</script>

<style lang="scss" scoped>
.settings-details[open] {
    gap: 0.375rem;
}

.settings-legend {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--ui-text-dimmed);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0;
    margin-bottom: 0.125rem;
}

.settings-legend.is-toggle {
    cursor: pointer;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 0.375rem;
}

.settings-legend.is-toggle::-webkit-details-marker {
    display: none;
}

.settings-legend.is-toggle::before {
    content: "";
    display: inline-block;
    width: 0;
    height: 0;
    border-style: solid;
    border-width: 0.3rem 0 0.3rem 0.4rem;
    border-color: transparent transparent transparent var(--ui-text-dimmed);
    transition: transform $ease-standard;
    flex-shrink: 0;
}

.settings-details[open] > .settings-legend.is-toggle::before {
    transform: rotate(90deg);
}

.settings-hint {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.35;
    color: var(--ui-text-dimmed);
}

.settings-shortcut-row {
    padding: 0.25rem 0;
}

.settings-shortcut-label {
    font-size: 0.8125rem;
    color: var(--ui-text);
}

.settings-shortcut-keys {
    gap: 0.15rem;
    white-space: nowrap;
}

.settings-kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 0.25rem;
    font-family: var(--app-font-mono);
    font-size: 0.6875rem;
    font-weight: 500;
    line-height: 1;
    color: var(--ui-text-muted);
    background: color-mix(in oklab, var(--ui-bg-muted) 55%, var(--ui-bg) 45%);
    border: 1px solid var(--ui-border);
    border-bottom-width: 2px;
    border-radius: 0.25rem;
}
</style>
