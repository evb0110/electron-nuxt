<template>
    <div
        v-if="visible"
        :class="containerClass"
        role="status"
        aria-live="polite"
    >
        <div class="flex items-center gap-2">
            <UIcon
                v-if="state === 'success'"
                name="i-ph-check-circle"
                class="size-4 text-[var(--ui-success)]"
                aria-hidden="true"
            />
            <AppSpinner v-else size="sm" tone="muted" />
            <div class="min-w-0 flex-1">
                <p class="m-0 text-xs font-medium text-default">
                    {{ title }}
                </p>
                <p v-if="detail" class="m-0 text-[11px] text-muted">
                    {{ detail }}
                </p>
                <p v-if="subDetail" class="m-0 text-[11px] text-dimmed">
                    {{ subDetail }}
                </p>
            </div>
        </div>
        <UProgress
            :value="progressValue"
            class="mt-2"
        />
    </div>
</template>

<script setup lang="ts">
import AppSpinner from '@app/components/AppSpinner.vue';

type TProgressChipState = 'running' | 'success';
type TProgressChipOffset = 'low' | 'high';

interface IAppProgressChipProps {
    visible?: boolean;
    title: string;
    detail?: string;
    subDetail?: string;
    value?: number | null;
    state?: TProgressChipState;
    offsetBottom?: TProgressChipOffset;
}

const {
    visible = true,
    detail = '',
    subDetail = '',
    value = null,
    state = 'running',
    offsetBottom = 'low',
} = defineProps<IAppProgressChipProps>();

const progressValue = computed(() => {
    if (state === 'success') {
        return 100;
    }
    return value ?? undefined;
});

const containerClass = computed(() => {
    const offsetClass = offsetBottom === 'high' ? 'bottom-28' : 'bottom-12';
    return [
        'pointer-events-none absolute right-4 z-50 w-60',
        'rounded-md border border-default bg-default/95 px-3 py-2 shadow-lg',
        offsetClass,
    ].join(' ');
});
</script>
