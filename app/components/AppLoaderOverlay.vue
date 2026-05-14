<template>
    <div
        v-if="visible"
        :class="containerClass"
        role="status"
        aria-live="polite"
    >
        <div class="flex flex-col items-center gap-2">
            <AppSpinner :size="size" tone="muted" />
            <span
                v-if="label"
                class="text-sm text-[var(--ui-text-muted)]"
            >{{ label }}</span>
        </div>
    </div>
</template>

<script setup lang="ts">
import AppSpinner from '@app/components/AppSpinner.vue';

type TLoaderOverlaySize = 'sm' | 'md';
type TLoaderOverlayBackground = 'muted' | 'transparent';

interface IAppLoaderOverlayProps {
    visible?: boolean;
    label?: string;
    background?: TLoaderOverlayBackground;
    size?: TLoaderOverlaySize;
}

const {
    visible = true,
    label = '',
    background = 'muted',
    size = 'md',
} = defineProps<IAppLoaderOverlayProps>();

const containerClass = computed(() => {
    const base = 'pointer-events-none absolute inset-0 z-[1] flex items-center justify-center';
    if (background === 'transparent') {
        return `${base} bg-transparent`;
    }
    return `${base} bg-[var(--ui-bg-muted)]`;
});
</script>
