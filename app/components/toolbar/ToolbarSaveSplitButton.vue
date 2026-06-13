<template>
    <div class="save-split" :class="{ 'is-open': menuOpen, 'is-primary-disabled': primaryDisabled }">
        <AppTooltip :delay-duration="1200" :disabled="primaryDisabled">
            <button
                type="button"
                class="save-split-primary"
                :class="{ 'is-loading': isSaving }"
                :disabled="primaryDisabled"
                :aria-label="saveTooltip"
                :aria-busy="isSaving"
                @click="handleSave"
            >
                <Icon v-if="!isSaving" name="ph:floppy-disk" class="save-split-icon" aria-hidden="true" />
                <Icon v-else name="ph:circle-notch" class="save-split-icon animate-spin" aria-hidden="true" />
            </button>

            <template #content>
                <span class="toolbar-tooltip-label">{{ saveTooltip }}</span>
                <span
                    v-if="saveShortcut"
                    class="toolbar-tooltip-shortcut"
                    aria-hidden="true"
                >
                    {{ saveShortcut }}
                </span>
            </template>
        </AppTooltip>

        <UDropdownMenu
            v-model:open="menuOpen"
            :items="saveMenuItems"
            :content="menuContentOptions"
            :ui="saveMenuUi"
        >
            <button
                type="button"
                class="save-split-trigger"
                :disabled="triggerDisabled"
                aria-haspopup="menu"
                :aria-expanded="menuOpen"
                :aria-label="t('toolbar.saveOptions')"
            >
                <Icon name="ph:caret-down" class="save-split-chevron" aria-hidden="true" />
            </button>

            <template #item-trailing="{ item }">
                <span v-if="getMenuShortcut(item)" class="toolbar-menu-shortcut">
                    {{ getMenuShortcut(item) }}
                </span>
            </template>
        </UDropdownMenu>
    </div>
</template>

<script setup lang="ts">
const {
    saveDisabled = false,
    saveAsDisabled = false,
    isSaving = false,
    isSavingAs = false,
    saveShortcut = '',
    saveAsShortcut = '',
} = defineProps<{
    saveTooltip: string;
    saveDisabled?: boolean;
    saveAsDisabled?: boolean;
    isSaving?: boolean;
    isSavingAs?: boolean;
    saveShortcut?: string;
    saveAsShortcut?: string;
}>();

const emit = defineEmits<{
    save: [];
    'save-as': [];
}>();

const { t } = useTypedI18n();

const menuOpen = ref(false);

const primaryDisabled = computed(() => saveDisabled || isSaving);
const triggerDisabled = computed(() => primaryDisabled.value && (saveAsDisabled || isSavingAs));

const menuContentOptions = {
    side: 'bottom' as const,
    align: 'start' as const,
    sideOffset: 8,
    collisionPadding: 8,
};

const saveMenuUi = {
    content: 'save-split-menu toolbar-menu-panel',
    item: 'save-split-item toolbar-menu-item',
    itemLeadingIcon: 'save-split-menu-icon toolbar-menu-icon',
    itemLabel: 'toolbar-menu-label',
    itemTrailing: 'save-split-menu-trailing',
};

const saveMenuItems = computed(() => [
    {
        label: t('toolbar.save'),
        icon: 'ph:floppy-disk',
        disabled: primaryDisabled.value,
        shortcut: saveShortcut,
        onSelect: handleMenuSave,
    },
    {
        label: t('toolbar.saveAs'),
        icon: 'ph:floppy-disk-back',
        disabled: saveAsDisabled || isSavingAs,
        shortcut: saveAsShortcut,
        onSelect: handleSaveAs,
    },
]);

function handleSave() {
    emit('save');
}

function handleMenuSave() {
    menuOpen.value = false;
    emit('save');
}

function handleSaveAs() {
    menuOpen.value = false;
    emit('save-as');
}

function getMenuShortcut(item: unknown) {
    return typeof item === 'object' && item != null && 'shortcut' in item
        ? String(item.shortcut ?? '')
        : '';
}
</script>

<style lang="scss">
@use '@app/assets/css/toolbar-menu-shared';

.save-split-menu {
    min-width: var(--app-toolbar-save-menu-min-width);
}
</style>

<style lang="scss" scoped>
.save-split {
    display: inline-flex;
    align-items: center;
    height: var(--toolbar-control-height);
    border-radius: var(--app-toolbar-button-radius);
    transition: background-color 0.1s ease, box-shadow 0.1s ease;
}

.save-split-primary,
.save-split-trigger {
    display: flex;
    align-items: center;
    justify-content: center;
    height: var(--toolbar-control-height);
    border: none;
    background: transparent;
    color: var(--app-toolbar-control-inactive-fg);
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
}

.save-split-primary {
    width: var(--app-toolbar-save-primary-width);
    padding: var(--app-toolbar-button-padding);
    border-radius: var(--app-toolbar-button-radius) 0 0 var(--app-toolbar-button-radius);
}

.save-split-trigger {
    width: var(--app-toolbar-save-trigger-width);
    padding-right: 0.0625rem;
    border-radius: 0 var(--app-toolbar-button-radius) var(--app-toolbar-button-radius) 0;
}

/* HOVER, both actions live → the control lights as one recessed gray pill. */
.save-split:not(.is-primary-disabled, .is-open):hover .save-split-primary,
.save-split:not(.is-primary-disabled, .is-open):hover .save-split-trigger {
    background: var(--app-toolbar-control-hover-bg);
    color: var(--app-toolbar-control-hover-fg);
}

/* HOVER, Save unavailable → only the caret reacts, as a standalone control. */
.save-split.is-primary-disabled:not(.is-open) .save-split-trigger:not(:disabled):hover {
    background: var(--app-toolbar-control-hover-bg);
    color: var(--app-toolbar-control-hover-fg);
    border-radius: var(--app-toolbar-button-radius);
}

/*
 * OPEN (active) is a distinct, raised elevation — not the recessed hover.
 * With Save live we frame the whole engaged control (matches the app-menu
 * button); with Save disabled the active fill sits on the caret alone, so a
 * dead Save is never wrapped in an active border.
 */
.save-split.is-open:not(.is-primary-disabled) {
    background: var(--app-toolbar-control-active-bg);
    box-shadow: inset 0 0 0 1px var(--app-toolbar-control-active-border);
}

.save-split.is-open:not(.is-primary-disabled) .save-split-primary,
.save-split.is-open:not(.is-primary-disabled) .save-split-trigger,
.save-split.is-open.is-primary-disabled .save-split-trigger {
    color: var(--app-toolbar-control-hover-fg);
}

.save-split.is-open.is-primary-disabled .save-split-trigger {
    background: var(--app-toolbar-control-active-bg);
    box-shadow: inset 0 0 0 1px var(--app-toolbar-control-active-border);
    border-radius: var(--app-toolbar-button-radius);
}

.save-split-primary:focus-visible,
.save-split-trigger:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
    outline: none;
    position: relative;
    z-index: 1;
}

.save-split-primary:disabled,
.save-split-trigger:disabled {
    color: var(--app-toolbar-control-disabled-fg);
    opacity: var(--app-toolbar-control-disabled-opacity);
}

.save-split-primary:disabled.is-loading {
    opacity: 1;
    color: var(--ui-text-muted);
    cursor: wait;
}

.save-split-icon {
    width: var(--app-tab-close-size);
    height: var(--app-tab-close-size);
}

.save-split-chevron {
    width: var(--app-toolbar-save-chevron-size);
    height: var(--app-toolbar-save-chevron-size);
    transition: transform 0.15s ease;
}

.save-split.is-open .save-split-chevron {
    transform: rotate(180deg);
}

.toolbar-tooltip-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.toolbar-tooltip-shortcut {
    color: var(--ui-text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}
</style>
