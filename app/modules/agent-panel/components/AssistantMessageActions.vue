<template>
    <div class="agent-assistant-message-actions">
        <AppTooltip
            v-if="role === 'assistant'"
            :text="t('assistant.reportResponse')"
            :delay-duration="300"
        >
            <a
                class="agent-assistant-message-action"
                :href="contentReportUrl"
                target="_blank"
                rel="noopener noreferrer"
                :aria-label="t('assistant.reportResponse')"
            >
                <UIcon name="i-ph-flag" />
            </a>
        </AppTooltip>
        <AppTooltip :text="copyTooltip" :delay-duration="300">
            <UButton
                class="agent-assistant-message-action"
                :aria-label="copyTooltip"
                :icon="copyIcon"
                color="neutral"
                variant="ghost"
                size="xs"
                type="button"
                @click="emit('copy')"
            />
        </AppTooltip>
    </div>
</template>

<script setup lang="ts">
import type { IAgentAssistantChatMessage } from '@contracts/agent';
import { getAssistantContentReportUrl } from '@app/modules/agent-panel/utils/getAssistantContentReportUrl';
import { useTypedI18n } from '@app/composables/useTypedI18n';

interface IAssistantMessageActionsProps {
    copyIcon: string;
    copyTooltip: string;
    role: IAgentAssistantChatMessage['role'];
}

defineProps<IAssistantMessageActionsProps>();
const emit = defineEmits<{copy: []}>();
const { t } = useTypedI18n();
const contentReportUrl = getAssistantContentReportUrl();
</script>

<style scoped>
.agent-assistant-message-actions {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    gap: var(--app-space-xs);
    margin-top: 0.15rem;
}

.agent-assistant-message-action {
    display: inline-flex;
    flex: 0 0 auto;
    width: var(--app-assistant-inline-action-size);
    min-width: var(--app-assistant-inline-action-size);
    height: var(--app-assistant-inline-action-size);
    min-height: var(--app-assistant-inline-action-size);
    align-items: center;
    justify-content: center;
    border-radius: var(--ui-radius);
    color: var(--ui-text-muted);
    text-decoration: none;
    user-select: none;
}

.agent-assistant-message-action:hover {
    background: var(--ui-bg-elevated);
    color: var(--ui-text);
}
</style>
