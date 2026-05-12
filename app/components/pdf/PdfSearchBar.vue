<template>
    <div class="flex flex-col gap-1 px-2 py-1.5">
        <div class="flex items-center gap-1.5">
            <UInput
                ref="inputRef"
                v-model="searchQuery"
                class="min-w-0 flex-1"
                :placeholder="t('search.placeholder')"
                autofocus
                @keydown.enter.exact.prevent="emit('search')"
                @keydown.shift.enter="emit('previous')"
            >
                <template #leading>
                    <UIcon name="i-ph-magnifying-glass" class="size-4" />
                </template>
                <template v-if="searchQuery" #trailing>
                    <UButton
                        icon="i-ph-x"
                        variant="ghost"
                        color="neutral"
                        size="xs"
                        class="min-w-auto px-1"
                        :aria-label="t('search.clearSearchLabel')"
                        @click="clearQuery"
                    />
                </template>
            </UInput>

            <div class="flex shrink-0 items-center gap-0.5">
                <AppTooltip :text="t('search.previousMatch')" :delay-duration="1200">
                    <UButton
                        icon="i-ph-caret-up"
                        variant="ghost"
                        color="neutral"
                        size="xs"
                        :disabled="totalMatches === 0"
                        :aria-label="t('search.previousMatchLabel')"
                        @click="emit('previous')"
                    />
                </AppTooltip>
                <AppTooltip :text="t('search.nextMatch')" :delay-duration="1200">
                    <UButton
                        icon="i-ph-caret-down"
                        variant="ghost"
                        color="neutral"
                        size="xs"
                        :disabled="totalMatches === 0"
                        :aria-label="t('search.nextMatchLabel')"
                        @click="emit('next')"
                    />
                </AppTooltip>
            </div>
        </div>

        <div class="flex items-center gap-1">
            <UButton
                label="Aa"
                variant="ghost"
                color="neutral"
                size="xs"
                class="search-option-chip min-w-auto px-1.5 text-[11px] font-semibold"
                :class="{ 'is-active': options.matchCase }"
                :aria-label="t('search.caseSensitive')"
                @click="toggleOption('matchCase')"
            />
            <UButton
                label="W"
                variant="ghost"
                color="neutral"
                size="xs"
                class="search-option-chip min-w-auto px-1.5 text-[11px] font-semibold"
                :class="{ 'is-active': options.wholeWord }"
                :aria-label="t('search.wholeWord')"
                @click="toggleOption('wholeWord')"
            />
            <UButton
                label=".*"
                variant="ghost"
                color="neutral"
                size="xs"
                class="search-option-chip min-w-auto px-1.5 text-[11px] font-semibold"
                :class="{ 'is-active': options.useRegex }"
                :aria-label="t('search.regex')"
                @click="toggleOption('useRegex')"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import type { IPdfSearchRequestOptions } from '@contracts/search';

const { t } = useTypedI18n();

interface IProps {
    modelValue: string;
    totalMatches: number;
    options: Required<Pick<IPdfSearchRequestOptions, 'matchCase' | 'wholeWord' | 'useRegex'>>;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:modelValue', value: string): void;
    (e: 'update:options', value: Required<Pick<IPdfSearchRequestOptions, 'matchCase' | 'wholeWord' | 'useRegex'>>): void;
    (e: 'search'): void;
    (e: 'next'): void;
    (e: 'previous'): void;
}>();

const inputRef = ref<{ $el: HTMLElement } | null>(null);

const searchQuery = computed({
    get: () => props.modelValue,
    set: (value: string) => {
        if (value === props.modelValue) {
            return;
        }
        emit('update:modelValue', value);
    },
});

function focus() {
    inputRef.value?.$el?.querySelector('input')?.focus();
}

function clearQuery() {
    if (!searchQuery.value) {
        return;
    }
    searchQuery.value = '';
    emit('search');
    focus();
}

function toggleOption(key: keyof IProps['options']) {
    emit('update:options', {
        ...props.options,
        [key]: !props.options[key],
    });
    focus();
}

defineExpose({ focus });
</script>

<style scoped>
.search-option-chip {
    border: 1px solid transparent;
    border-radius: 0.375rem;
}

.search-option-chip:hover {
    background: var(--app-sidebar-control-hover-bg);
    color: var(--ui-text);
}

.search-option-chip.is-active {
    border-color: var(--app-control-active-border);
    background: var(--app-control-active-bg);
    color: var(--ui-text);
}
</style>
