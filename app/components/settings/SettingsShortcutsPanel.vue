<template>
    <UCollapsible
        v-model:open="shortcutsOpen"
        :unmount-on-hide="false"
        class="settings-details flex flex-col"
    >
        <template #default="{ open }">
            <button
                type="button"
                class="settings-section-title is-toggle"
                :aria-expanded="open ? 'true' : 'false'"
            >
                <UIcon
                    :name="open ? 'i-ph-caret-down' : 'i-ph-caret-right'"
                    class="settings-toggle-icon"
                />
                <span>{{ t('settings.shortcuts') }}</span>
            </button>
        </template>

        <template #content>
            <div class="settings-shortcuts-content flex flex-col">
                <p class="settings-field-hint">
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
                            <UKbd
                                v-for="(part, i) in item.keys"
                                :key="i"
                                class="settings-kbd"
                                size="sm"
                                variant="outline"
                            >{{ part }}</UKbd>
                        </span>
                    </div>
                </div>
            </div>
        </template>
    </UCollapsible>
</template>

<script setup lang="ts">
interface ISettingsShortcutItem {
    label: string;
    keys: string[];
}

defineProps<{
    description: string;
    items: ISettingsShortcutItem[];
}>();

const { t } = useTypedI18n();
const shortcutsOpen = ref(false);
</script>

<style lang="scss" scoped>
@use '@app/assets/css/settings-panel-shared';

.settings-section-title.is-toggle {
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    border: none;
    background: transparent;
}

.settings-toggle-icon {
    width: 0.875rem;
    height: 0.875rem;
    flex-shrink: 0;
    color: var(--ui-text-dimmed);
}

.settings-shortcuts-content {
    gap: 0.375rem;
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
    font-family: var(--app-font-mono);
    text-transform: none;
}
</style>
