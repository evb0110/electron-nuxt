<template>
    <aside
        class="scan-page-list"
        :class="{'is-collapsed': collapsed}"
        :aria-label="t('scanCleanup.pages.title')"
        @keydown.up.prevent="moveSelection(-1)"
        @keydown.down.prevent="moveSelection(1)"
    >
        <header class="scan-page-list-header">
            <template v-if="!collapsed">
                <strong>{{ t('scanCleanup.pages.title') }}</strong>
                <UButton
                    type="button"
                    color="neutral"
                    variant="link"
                    size="xs"
                    :label="t('scanCleanup.pages.resetAll')"
                    :disabled="disabled || !hasOverrides"
                    @click="$emit('reset')"
                />
            </template>
            <UButton
                type="button"
                color="neutral"
                variant="ghost"
                size="xs"
                :label="collapsed ? t('scanCleanup.pages.expand') : t('scanCleanup.pages.collapse')"
                :aria-expanded="!collapsed"
                @click="$emit('update:collapsed', !collapsed)"
            />
        </header>

        <div
            v-if="!collapsed"
            class="scan-page-list-scroll app-scrollbar app-scroll-region--balanced"
            role="listbox"
            :aria-label="t('scanCleanup.pages.title')"
        >
            <div
                v-for="page in totalPages"
                :key="page"
                class="scan-page-row"
                :class="{'is-selected': page === pageNumber, 'is-excluded': pageOverride(page).excluded}"
                role="option"
                :aria-selected="page === pageNumber"
                :tabindex="page === pageNumber ? 0 : -1"
                @click="selectPage(page)"
                @focus="selectPage(page)"
            >
                <div class="scan-page-row-heading">
                    <span class="scan-page-number">{{ page }}</span>
                    <UBadge color="neutral" variant="soft" size="sm">
                        {{ classificationLabel(page) }}
                    </UBadge>
                </div>
                <div class="scan-page-row-controls" @click.stop>
                    <USelect
                        :model-value="pageOverride(page).layoutOverride"
                        :items="overrideItems"
                        value-key="value"
                        size="xs"
                        :aria-label="t('scanCleanup.pages.overrideFor', {page})"
                        :disabled="disabled"
                        @update:model-value="updateOverride(page, {layoutOverride: $event})"
                    />
                    <UButton
                        type="button"
                        color="neutral"
                        variant="outline"
                        size="xs"
                        :label="`${pageOverride(page).rotation}°`"
                        :aria-label="t('scanCleanup.pages.rotateFor', {page, rotation: pageOverride(page).rotation})"
                        :disabled="disabled"
                        @click="rotate(page)"
                    />
                    <UCheckbox
                        :model-value="pageOverride(page).excluded"
                        :aria-label="t('scanCleanup.pages.excludeFor', {page})"
                        :disabled="disabled"
                        @update:model-value="updateOverride(page, {excluded: Boolean($event)})"
                    />
                </div>
            </div>
        </div>
    </aside>
</template>

<script setup lang="ts">
import type {
    IScanCleanupPageOverride,
    IScanCleanupPreviewMetadata,
    TScanCleanupPageLayoutOverride,
    TScanCleanupPageOverrides,
    TScanCleanupPageRotation,
} from '@contracts/electronApiScanCleanup';
import {
    createScanCleanupPageOverride,
    getScanCleanupPageOverride,
} from '@contracts/scanCleanupPageOverrides';

const props = defineProps<{
    pageNumber: number;
    totalPages: number;
    overrides: TScanCleanupPageOverrides;
    classifications: ReadonlyMap<number, IScanCleanupPreviewMetadata['layoutClassification']>;
    collapsed: boolean;
    disabled: boolean;
}>();

const emit = defineEmits<{
    'update:pageNumber': [page: number];
    'update:override': [page: number, value: IScanCleanupPageOverride];
    'update:collapsed': [collapsed: boolean];
    reset: [];
}>();

const {t} = useTypedI18n();
const hasOverrides = computed(() => Object.keys(props.overrides).length > 0);
const overrideItems = computed<Array<{
    label: string;
    value: TScanCleanupPageLayoutOverride
}>>(() => [
    {
        value: 'auto',
        label: t('scanCleanup.pages.override.auto'),
    },
    {
        value: 'single',
        label: t('scanCleanup.pages.override.single'),
    },
    {
        value: 'spread',
        label: t('scanCleanup.pages.override.spread'),
    },
    {
        value: 'keep-left',
        label: t('scanCleanup.pages.override.keepLeft'),
    },
    {
        value: 'keep-right',
        label: t('scanCleanup.pages.override.keepRight'),
    },
]);

function pageOverride(page: number) {
    return getScanCleanupPageOverride(props.overrides, page);
}

function updateOverride(page: number, patch: Partial<IScanCleanupPageOverride>) {
    emit('update:override', page, createScanCleanupPageOverride({
        ...pageOverride(page),
        ...patch,
    }));
}

function rotate(page: number) {
    const rotations: TScanCleanupPageRotation[] = [
        0,
        90,
        180,
        270,
    ];
    const current = pageOverride(page).rotation;
    const next = rotations[(rotations.indexOf(current) + 1) % rotations.length] ?? 0;
    updateOverride(page, {rotation: next});
}

function selectPage(page: number) {
    emit('update:pageNumber', page);
}

function moveSelection(delta: number) {
    selectPage(Math.min(props.totalPages, Math.max(1, props.pageNumber + delta)));
}

function classificationLabel(page: number) {
    const classification = props.classifications.get(page);
    if (classification === 'two-page-spread') {
        return t('scanCleanup.pages.classification.spread');
    }
    if (classification === 'page-with-offcut') {
        return t('scanCleanup.pages.classification.offcut');
    }
    if (classification === 'single-uncut-page') {
        return t('scanCleanup.pages.classification.single');
    }
    return t('scanCleanup.pages.classification.pending');
}
</script>

<style scoped>
.scan-page-list {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    border-inline-end: 1px solid var(--ui-border);
    background: var(--ui-bg);
}

.scan-page-list.is-collapsed {
    align-items: center;
}

.scan-page-list.is-collapsed .scan-page-list-header {
    padding-inline: var(--app-space-sm);
}

.scan-page-list.is-collapsed .scan-page-list-header > * {
    writing-mode: vertical-rl;
}

.scan-page-list-header {
    display: flex;
    min-height: var(--app-control-height-md);
    align-items: center;
    justify-content: space-between;
    gap: var(--app-space-sm);
    padding: var(--app-space-5xl);
    border-block-end: 1px solid var(--ui-border);
}

.scan-page-list-header strong {
    font-size: var(--app-text-size-secondary);
}

.scan-page-list-scroll {
    min-height: 0;
    flex: 1;
    overflow-y: auto;
    padding: var(--app-space-3xl);
}

.scan-page-row {
    display: grid;
    gap: var(--app-space-sm);
    padding: var(--app-space-5xl);
    border: 1px solid transparent;
    border-radius: var(--app-radius-md);
    cursor: pointer;
}

.scan-page-row + .scan-page-row {
    margin-block-start: var(--app-space-sm);
}

.scan-page-row:hover {
    background: var(--ui-bg-elevated);
}

.scan-page-row.is-selected {
    border-color: var(--ui-primary);
    background: color-mix(in srgb, var(--ui-primary) 8%, transparent);
}

.scan-page-row.is-excluded {
    opacity: var(--app-scan-disabled-opacity);
}

.scan-page-row:focus-visible {
    outline: 2px solid var(--ui-primary);
    outline-offset: var(--app-space-xs);
}

.scan-page-row-heading,
.scan-page-row-controls {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: var(--app-space-sm);
}

.scan-page-row-heading {
    justify-content: space-between;
}

.scan-page-number {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
}

.scan-page-row-controls > :first-child {
    min-width: 0;
    flex: 1;
}
</style>
