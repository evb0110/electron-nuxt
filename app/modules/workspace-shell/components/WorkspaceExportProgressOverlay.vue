<template>
    <AppProgressChip
        :visible="overlay !== null"
        :title="title"
        :detail="detail"
        :state="overlay?.state ?? 'running'"
        offset-bottom="low"
    />
</template>

<script setup lang="ts">
import AppProgressChip from '@app/components/AppProgressChip.vue';

interface IWorkspaceExportOverlay {
    kind: 'images' | 'multipage-tiff';
    state: 'running' | 'success';
    pageCount: number;
}

const { overlay } = defineProps<{overlay: IWorkspaceExportOverlay | null;}>();

const { t } = useTypedI18n();

const title = computed(() => {
    if (!overlay) {
        return '';
    }

    if (overlay.state === 'success') {
        return overlay.kind === 'images'
            ? t('export.successImages')
            : t('export.successTiff');
    }

    return overlay.kind === 'images'
        ? t('export.statusImages')
        : t('export.statusTiff');
});
const detail = computed(() => overlay
    ? t('export.pageCount', {count: overlay.pageCount})
    : '');
</script>
