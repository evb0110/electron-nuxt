<template>
    <div
        v-if="overlay"
        class="pointer-events-none absolute bottom-12 right-4 z-50 w-60 rounded-md border border-default bg-default/95 px-3 py-2 shadow-lg"
        role="status"
        aria-live="polite"
    >
        <div class="flex items-center gap-2">
            <UIcon :name="icon" :class="iconClass" />
            <div class="min-w-0">
                <p class="m-0 text-xs font-medium text-default">
                    {{ title }}
                </p>
                <p class="m-0 text-[11px] text-muted">
                    {{ detail }}
                </p>
            </div>
        </div>
        <UProgress
            v-if="overlay.state === 'success'"
            :value="100"
            class="mt-2"
        />
        <UProgress
            v-else
            class="mt-2"
        />
    </div>
</template>

<script setup lang="ts">
interface IWorkspaceExportOverlay {
    kind: 'images' | 'multipage-tiff';
    state: 'running' | 'success';
    pageCount: number;
}

const props = defineProps<{overlay: IWorkspaceExportOverlay | null;}>();

const { t } = useTypedI18n();

const title = computed(() => {
    if (!props.overlay) {
        return '';
    }

    if (props.overlay.state === 'success') {
        return props.overlay.kind === 'images'
            ? t('export.successImages')
            : t('export.successTiff');
    }

    return props.overlay.kind === 'images'
        ? t('export.statusImages')
        : t('export.statusTiff');
});
const detail = computed(() => props.overlay
    ? t('export.pageCount', {count: props.overlay.pageCount})
    : '');
const icon = computed(() => props.overlay?.state === 'success'
    ? 'i-ph-check-circle'
    : 'i-ph-circle-notch');
const iconClass = computed(() => props.overlay?.state === 'success'
    ? 'size-4 text-[var(--ui-success)]'
    : 'size-4 animate-spin text-muted');
</script>
