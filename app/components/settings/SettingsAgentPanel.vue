<template>
    <fieldset class="settings-section flex flex-col gap-2.5">
        <legend class="settings-section-title">{{ t('settings.agentMcp') }}</legend>

        <div class="settings-agent-card">
            <div class="settings-agent-main">
                <div class="settings-agent-status">
                    <UIcon
                        :name="statusIcon"
                        class="settings-agent-status-icon"
                        :class="statusClass"
                    />
                    <span class="settings-agent-status-label">{{ statusLabel }}</span>
                </div>
                <p class="settings-field-hint">{{ statusHint }}</p>
            </div>

            <div class="settings-agent-actions">
                <UButton
                    :label="primaryActionLabel"
                    :icon="primaryActionIcon"
                    color="neutral"
                    :variant="status?.enabled && !needsRepair ? 'soft' : 'solid'"
                    :loading="isBusy"
                    :disabled="isBusy || !status"
                    @click="emit('setEnabled', primaryActionEnabled)"
                />
                <UButton
                    :aria-label="t('settings.agentMcpRefresh')"
                    icon="i-ph-arrows-clockwise"
                    color="neutral"
                    variant="ghost"
                    :loading="isBusy"
                    :disabled="isBusy"
                    @click="emit('refresh')"
                />
            </div>
        </div>

        <dl
            v-if="status"
            class="settings-agent-details"
        >
            <div>
                <dt>{{ t('settings.agentMcpServerName') }}</dt>
                <dd>{{ status.serverName }}</dd>
            </div>
            <div>
                <dt>{{ t('settings.agentMcpUrl') }}</dt>
                <dd>{{ status.serverUrl || t('settings.agentMcpUnavailable') }}</dd>
            </div>
            <div>
                <dt>{{ t('settings.agentMcpCodex') }}</dt>
                <dd>{{ codexLocationLabel }}</dd>
            </div>
        </dl>

        <div
            v-if="showInstallCodex"
            class="settings-agent-install"
        >
            <p class="settings-field-hint">{{ t('settings.agentMcpInstallHint') }}</p>
            <UButton
                :label="t('settings.agentMcpInstallCodex')"
                icon="i-ph-arrow-square-out"
                color="neutral"
                variant="outline"
                @click="emit('openInstall')"
            />
        </div>
    </fieldset>
</template>

<script setup lang="ts">
import type {
    IAgentMcpIntegrationStatus,
    TAgentMcpCodexRegistrationState,
} from '@contracts/agent';

const props = defineProps<{
    status: IAgentMcpIntegrationStatus | null;
    isBusy: boolean;
}>();

const emit = defineEmits<{
    setEnabled: [enabled: boolean];
    refresh: [];
    openInstall: [];
}>();

const { t } = useTypedI18n();

const needsRepair = computed(() => props.status?.enabled === true && (
    !props.status.serverRunning
    || !props.status.codexConfigured
    || props.status.codexRegistrationState !== 'configured'
));

const primaryActionEnabled = computed(() => {
    if (needsRepair.value) {
        return true;
    }
    return props.status?.enabled !== true;
});

const primaryActionLabel = computed(() => {
    if (needsRepair.value) {
        return t('settings.agentMcpRepair');
    }
    return props.status?.enabled
        ? t('settings.agentMcpDisable')
        : t('settings.agentMcpEnable');
});

const primaryActionIcon = computed(() => {
    if (needsRepair.value) {
        return 'i-ph-arrows-clockwise';
    }
    return props.status?.enabled
        ? 'i-ph-warning-circle'
        : 'i-ph-check-circle';
});

const showInstallCodex = computed(() => props.status !== null && !props.status.codexInstalled);

const statusKind = computed<TAgentMcpCodexRegistrationState | 'disabled' | 'error' | 'starting'>(() => {
    const status = props.status;
    if (!status) {
        return 'starting';
    }
    if (status.error) {
        return 'error';
    }
    if (!status.enabled) {
        return 'disabled';
    }
    if (!status.codexInstalled) {
        return 'unknown';
    }
    if (status.serverRunning && status.codexConfigured && status.codexRegistrationState === 'configured') {
        return 'configured';
    }
    return status.codexRegistrationState;
});

const statusLabel = computed(() => {
    switch (statusKind.value) {
        case 'configured':
            return t('settings.agentMcpStatusReady');
        case 'disabled':
            return t('settings.agentMcpStatusDisabled');
        case 'missing':
            return t('settings.agentMcpStatusMissing');
        case 'mismatched':
            return t('settings.agentMcpStatusMismatched');
        case 'error':
            return t('settings.agentMcpStatusError');
        case 'starting':
            return t('settings.agentMcpStatusStarting');
        case 'unknown':
        default:
            return t('settings.agentMcpStatusCodexMissing');
    }
});

const statusHint = computed(() => {
    const status = props.status;
    if (!status) {
        return t('settings.agentMcpDescription');
    }
    if (status.error) {
        return status.error;
    }
    if (!status.enabled) {
        return t('settings.agentMcpDescription');
    }
    if (!status.codexInstalled) {
        return t('settings.agentMcpInstallHint');
    }
    if (!status.serverRunning) {
        return t('settings.agentMcpStatusServerStopped');
    }
    if (!status.codexConfigured) {
        return t('settings.agentMcpStatusMismatchedHint');
    }
    return t('settings.agentMcpStatusReadyHint');
});

const statusIcon = computed(() => {
    switch (statusKind.value) {
        case 'configured':
            return 'i-ph-check-circle';
        case 'starting':
            return 'i-ph-arrows-clockwise';
        case 'disabled':
            return 'i-ph-chat-circle-dots';
        default:
            return 'i-ph-warning-circle';
    }
});

const statusClass = computed(() => ({
    'is-ready': statusKind.value === 'configured',
    'is-warning': statusKind.value !== 'configured' && statusKind.value !== 'disabled' && statusKind.value !== 'starting',
}));

const codexLocationLabel = computed(() => {
    if (!props.status?.codexInstalled) {
        return t('settings.agentMcpCodexMissing');
    }
    return props.status.codexPath ?? t('settings.agentMcpUnavailable');
});
</script>

<style lang="scss" scoped>
@use '@app/assets/css/settingsPanelShared';

.settings-agent-card {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.75rem;
    border: 1px solid var(--ui-border);
    border-radius: var(--ui-radius);
    background: var(--ui-bg-elevated);
}

.settings-agent-main {
    flex: 1 1 auto;
    min-width: 0;
}

.settings-agent-status {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--ui-text);
}

.settings-agent-status-icon {
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
    color: var(--ui-text-dimmed);
}

.settings-agent-status-icon.is-ready {
    color: var(--ui-primary);
}

.settings-agent-status-icon.is-warning {
    color: var(--ui-text);
}

.settings-agent-status-label {
    font-size: 0.875rem;
    font-weight: 600;
}

.settings-agent-actions {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-shrink: 0;
}

.settings-agent-details {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.35rem;
    margin: 0;
}

.settings-agent-details div {
    display: grid;
    grid-template-columns: minmax(5.5rem, 0.35fr) minmax(0, 1fr);
    gap: 0.5rem;
    min-width: 0;
}

.settings-agent-details dt {
    color: var(--ui-text-dimmed);
    font-size: 0.75rem;
}

.settings-agent-details dd {
    margin: 0;
    min-width: 0;
    color: var(--ui-text);
    font-size: 0.75rem;
    overflow-wrap: anywhere;
}

.settings-agent-install {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
}

@media (width <= 36rem) {
    .settings-agent-card,
    .settings-agent-install {
        flex-direction: column;
        align-items: stretch;
    }

    .settings-agent-actions {
        justify-content: flex-start;
    }
}
</style>
