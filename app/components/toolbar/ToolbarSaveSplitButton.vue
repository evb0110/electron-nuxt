<template>
    <div class="save-split" :class="{ 'is-open': menuOpen }">
        <AppTooltip :delay-duration="1200">
            <button
                type="button"
                class="save-split-primary"
                :disabled="saveDisabled || isSaving"
                :class="{ 'is-loading': isSaving }"
                :aria-label="saveTooltip"
                @click="handleSave"
            >
                <Icon v-if="!isSaving" name="ph:floppy-disk" class="save-split-icon" />
                <Icon v-else name="ph:circle-notch" class="save-split-icon animate-spin" />
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

        <UPopover v-model:open="menuOpen" mode="click" :content="menuContentOptions">
            <button
                type="button"
                class="save-split-trigger"
                :class="{ 'is-open': menuOpen }"
                :disabled="triggerDisabled"
                aria-haspopup="menu"
                :aria-expanded="menuOpen"
                :aria-label="t('toolbar.saveOptions')"
            >
                <Icon name="ph:caret-down" class="save-split-chevron" />
            </button>

            <template #content>
                <div class="save-split-menu toolbar-menu-panel">
                    <button
                        class="save-split-item toolbar-menu-item"
                        :disabled="saveDisabled || isSaving"
                        @click="handleMenuSave"
                    >
                        <Icon name="ph:floppy-disk" class="save-split-menu-icon toolbar-menu-icon" />
                        <span class="toolbar-menu-label">{{ t('toolbar.save') }}</span>
                        <span v-if="saveShortcut" class="toolbar-menu-shortcut">{{ saveShortcut }}</span>
                    </button>
                    <button
                        class="save-split-item toolbar-menu-item"
                        :disabled="saveAsDisabled || isSavingAs"
                        @click="handleSaveAs"
                    >
                        <Icon name="ph:floppy-disk-back" class="save-split-menu-icon toolbar-menu-icon" />
                        <span class="toolbar-menu-label">{{ t('toolbar.saveAs') }}</span>
                        <span v-if="saveAsShortcut" class="toolbar-menu-shortcut">{{ saveAsShortcut }}</span>
                    </button>
                </div>
            </template>
        </UPopover>
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

// The chevron stays usable whenever either action is available, so "Save As…"
// remains reachable even when an unmodified document cannot be plain-saved.
const triggerDisabled = computed(() => (saveDisabled || isSaving) && (saveAsDisabled || isSavingAs));

const menuContentOptions = {
    side: 'bottom' as const,
    align: 'start' as const,
    sideOffset: 8,
    collisionPadding: 8,
};

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
</script>

<style lang="scss" scoped>
@use '@app/assets/css/toolbarMenuShared';

.save-split {
    display: inline-flex;
    align-items: stretch;
    height: var(--toolbar-control-height);
    border: 1px solid transparent;
    border-radius: 0.4375rem;
    overflow: hidden;
}

.save-split:hover,
.save-split.is-open {
    border-color: var(--app-toolbar-control-hover-border);
}

.save-split-primary,
.save-split-trigger {
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    color: var(--app-toolbar-control-inactive-fg);
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
}

.save-split-primary {
    width: var(--toolbar-control-height);
    padding: 0.32rem;
}

.save-split-trigger {
    width: 1.125rem;
    padding: 0;
    border-left: 1px solid var(--app-toolbar-separator);
}

.save-split-primary:hover:not(:disabled),
.save-split-trigger:hover:not(:disabled),
.save-split-trigger.is-open {
    background: var(--app-toolbar-control-hover-bg);
    color: var(--app-toolbar-control-hover-fg);
}

.save-split-trigger.is-open {
    background: var(--app-toolbar-control-active-bg);
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
    opacity: var(--app-toolbar-control-disabled-opacity);
    color: var(--app-toolbar-control-disabled-fg);
    cursor: not-allowed;
}

.save-split-primary:disabled.is-loading {
    opacity: 1;
    color: var(--ui-text-muted);
    cursor: wait;
}

.save-split-icon {
    width: 1.25rem;
    height: 1.25rem;
}

.save-split-chevron {
    width: 0.75rem;
    height: 0.75rem;
}

.save-split-menu {
    min-width: 11rem;
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
