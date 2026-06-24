<template>
    <UModal
        :open="open"
        :title="t('tabs.confirmCloseDirtyTitle')"
        :ui="{ footer: 'justify-end gap-2' }"
        @update:open="handleOpenUpdate"
    >
        <template #description>
            <span class="sr-only">
                {{ t('tabs.confirmCloseDirtyDescription', { name: targetName }) }}
            </span>
        </template>

        <template #body>
            <p class="text-sm text-muted">
                {{ t('tabs.confirmCloseDirtyDescription', { name: targetName }) }}
            </p>
        </template>

        <template #footer="{ close }">
            <UButton
                :label="t('common.cancel')"
                color="neutral"
                variant="outline"
                @click="close"
            />
            <UButton
                :label="t('tabs.closeTab')"
                color="primary"
                @click="handleConfirm"
            />
        </template>
    </UModal>
</template>

<script setup lang="ts">
defineProps<{
    open: boolean;
    targetName: string;
}>();

const emit = defineEmits<{
    'update:open': [open: boolean];
    confirm: [];
}>();

const { t } = useTypedI18n();

function handleOpenUpdate(open: boolean) {
    emit('update:open', open);
}

function handleConfirm() {
    emit('confirm');
}
</script>
