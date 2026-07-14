<template>
    <div v-if="active" class="agent-assistant-turn-progress">
        <UIcon name="i-ph-circle-notch" class="agent-assistant-working-icon is-spinning" />
        <span>{{ statusText }}</span>
    </div>
    <details v-if="reasoning" class="agent-assistant-reasoning" open>
        <summary>Thinking…</summary>
        <pre class="app-scrollbar app-scroll-region--balanced">{{ reasoning }}</pre>
    </details>
    <div
        v-for="tool in tools"
        :key="tool.toolId"
        class="agent-assistant-tool-activity"
    >
        <UIcon :name="tool.phase === 'running' ? 'i-ph-circle-notch' : 'i-ph-check-circle'" />
        <span>{{ tool.name }} — {{ tool.phase }}</span>
    </div>
    <span v-if="usage" class="agent-assistant-tool-activity">
        {{ usage.inputTokens }} input · {{ usage.outputTokens }} output tokens
    </span>
    <p v-if="stalled" class="agent-assistant-composer-error">
        No signal from the assistant. It may be stuck; stop the turn or retry.
    </p>
    <UButton
        v-if="canRetry"
        label="Retry"
        icon="i-ph-arrow-clockwise"
        color="neutral"
        variant="outline"
        size="xs"
        @click="$emit('retry')"
    />
</template>

<script setup lang="ts">
import type { IAgentAssistantTurnState } from '@contracts/agent';

defineProps<{
    active: boolean;
    canRetry: boolean;
    reasoning: string;
    stalled: boolean;
    statusText: string;
    tools: IAgentAssistantTurnState['toolActivity'];
    usage: IAgentAssistantTurnState['usage'];
}>();

defineEmits<{retry: []}>();
</script>
