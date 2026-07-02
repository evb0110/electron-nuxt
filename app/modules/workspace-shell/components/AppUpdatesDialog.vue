<template>
    <UModal
        :open="open"
        :title="title"
        :ui="{ footer: 'justify-end gap-2' }"
        @update:open="handleOpenUpdate"
    >
        <template #description>
            <span class="sr-only">
                {{ description }}
            </span>
        </template>

        <template #body>
            <div class="flex flex-col gap-3">
                <p class="text-sm text-muted">
                    {{ description }}
                </p>
                <AppProgressBar :value="progressPercent ?? null" />
            </div>
        </template>

        <template #footer="{ close }">
            <template v-if="ready">
                <UButton
                    :label="t('updates.deferAction')"
                    color="neutral"
                    variant="outline"
                    @click="handleDefer"
                />
                <UButton
                    :label="t('updates.skipAction')"
                    color="neutral"
                    variant="outline"
                    @click="handleSkip"
                />
                <UButton
                    :label="t('updates.installAction')"
                    color="primary"
                    @click="handleInstall"
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
import AppProgressBar from '@app/components/AppProgressBar.vue';

defineProps<{
    open: boolean;
    title: string;
    description: string;
    progressPercent?: number | null;
    ready: boolean;
}>();

const emit = defineEmits<{
    'update:open': [open: boolean];
    defer: [];
    skip: [];
    install: [];
}>();

const { t } = useTypedI18n();

function handleOpenUpdate(open: boolean) {
    emit('update:open', open);
}

function handleDefer() {
    emit('defer');
}

function handleSkip() {
    emit('skip');
}

function handleInstall() {
    emit('install');
}
</script>
