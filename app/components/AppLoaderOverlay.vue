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
                class="app-loader-overlay-label"
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
    const base = 'app-loader-overlay pointer-events-none absolute inset-0 flex items-center justify-center';
    if (background === 'transparent') {
        return `${base} bg-transparent`;
    }
    return `${base} app-loader-overlay--muted`;
});
</script>

<style scoped>
.app-loader-overlay {
    /* Local content cover inside its positioned host, not a global overlay. */
    --app-loader-local-cover-layer: 1;

    z-index: var(--app-loader-local-cover-layer);
}

.app-loader-overlay--muted {
    background: var(--ui-bg-muted);
}

.app-loader-overlay-label {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body);
}
</style>
