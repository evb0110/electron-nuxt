<template>
    <UModal
        :open="open"
        :title="title"
        :ui="{ footer: 'justify-end' }"
        @update:open="emit('update:open', $event)"
    >
        <template #description>
            <span class="sr-only">
                {{ description }}
            </span>
        </template>

        <template #body>
            <p class="text-sm text-muted">
                {{ description }}
            </p>
        </template>

        <template #footer="{ close }">
            <template v-if="ready">
                <UButton
                    :label="t('updates.deferAction')"
                    color="neutral"
                    variant="outline"
                    @click="emit('defer')"
                />
                <UButton
                    :label="t('updates.skipAction')"
                    color="neutral"
                    variant="outline"
                    @click="emit('skip')"
                />
                <UButton
                    :label="t('updates.installAction')"
                    @click="emit('install')"
                />
            </template>
            <template v-else>
                <UButton
                    :label="t('settings.close')"
                    color="neutral"
                    variant="outline"
                    @click="close"
                />
            </template>
        </template>
    </UModal>
</template>

<script setup lang="ts">
defineProps<{
    open: boolean;
    title: string;
    description: string;
    ready: boolean;
}>();

const emit = defineEmits<{
    'update:open': [open: boolean];
    defer: [];
    skip: [];
    install: [];
}>();

const { t } = useTypedI18n();
</script>
