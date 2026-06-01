<template>
    <aside class="agent-assistant-panel">
        <header class="agent-assistant-header">
            <div class="agent-assistant-title">
                <UIcon name="i-ph-chat-circle-dots" class="agent-assistant-title-icon" />
                <span>{{ t('assistant.title') }}</span>
            </div>
            <div class="agent-assistant-header-actions">
                <UButton
                    :aria-label="t('assistant.refresh')"
                    icon="i-ph-arrows-clockwise"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    :loading="isRefreshing"
                    @click="refreshState"
                />
                <UButton
                    :aria-label="t('assistant.close')"
                    icon="i-ph-x"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    @click="emit('close')"
                />
            </div>
        </header>

        <div class="agent-assistant-body">
            <section
                v-if="!status.supported"
                class="agent-assistant-setup"
            >
                <UIcon name="i-ph-warning-circle" class="agent-assistant-setup-icon" />
                <h2>{{ t('assistant.unsupportedTitle') }}</h2>
                <p>{{ t('assistant.unsupportedDescription') }}</p>
            </section>

            <section
                v-else-if="!status.codexInstalled"
                class="agent-assistant-setup"
            >
                <UIcon name="i-ph-download-simple" class="agent-assistant-setup-icon" />
                <h2>{{ t('assistant.installTitle') }}</h2>
                <p>{{ t('assistant.installDescription') }}</p>
                <UButton
                    :label="installButtonLabel"
                    icon="i-ph-download-simple"
                    color="primary"
                    :loading="isInstalling"
                    :disabled="isInstalling"
                    @click="installCodex"
                />
                <p
                    v-if="installProgress"
                    class="agent-assistant-progress"
                >
                    {{ installProgress }}
                </p>
            </section>

            <section
                v-else-if="!status.codexVersionSupported"
                class="agent-assistant-setup"
            >
                <UIcon name="i-ph-warning-circle" class="agent-assistant-setup-icon" />
                <h2>{{ t('assistant.updateTitle') }}</h2>
                <p>{{ t('assistant.updateDescription', { version: status.minimumCodexVersion }) }}</p>
                <UButton
                    :label="t('assistant.updateCodex')"
                    icon="i-ph-arrows-clockwise"
                    color="primary"
                    :loading="isInstalling"
                    :disabled="isInstalling"
                    @click="installCodex"
                />
            </section>

            <section
                v-else-if="status.authState !== 'signed-in'"
                class="agent-assistant-setup"
            >
                <UIcon name="i-ph-chat-circle-dots" class="agent-assistant-setup-icon" />
                <h2>{{ t('assistant.signInTitle') }}</h2>
                <p>{{ t('assistant.signInDescription') }}</p>
                <div class="agent-assistant-setup-actions">
                    <UButton
                        :label="t('assistant.signInChatGpt')"
                        icon="i-ph-arrow-square-out"
                        color="primary"
                        :loading="isLoggingIn && loginMode === 'chatgpt'"
                        :disabled="isLoggingIn || status.authState === 'login-pending'"
                        @click="startLogin('chatgpt')"
                    />
                    <UButton
                        v-if="status.authState === 'login-pending'"
                        :label="t('assistant.cancelLogin')"
                        icon="i-ph-x"
                        color="neutral"
                        variant="outline"
                        :disabled="isLoggingIn"
                        @click="cancelLogin"
                    />
                </div>
                <div
                    v-if="deviceCode"
                    class="agent-assistant-device-code"
                >
                    <span>{{ t('assistant.deviceCode') }}</span>
                    <strong>{{ deviceCode }}</strong>
                </div>
                <p
                    v-if="status.authState === 'login-pending'"
                    class="agent-assistant-progress"
                >
                    {{ t('assistant.loginPending') }}
                </p>
            </section>

            <template v-else>
                <div class="agent-assistant-status-line">
                    <span>{{ signedInLabel }}</span>
                    <span>{{ toolsLabel }}</span>
                </div>

                <div
                    ref="messagesRef"
                    class="agent-assistant-messages"
                >
                    <div
                        v-if="messages.length === 0"
                        class="agent-assistant-empty"
                    >
                        <UIcon name="i-ph-lightbulb" class="agent-assistant-empty-icon" />
                        <h2>{{ emptyTitle }}</h2>
                        <p>{{ emptyDescription }}</p>
                    </div>

                    <article
                        v-for="message in messages"
                        :key="message.id"
                        class="agent-assistant-message"
                        :class="`is-${message.role}`"
                    >
                        <div class="agent-assistant-message-role">
                            {{ roleLabel(message.role) }}
                        </div>
                        <p>{{ message.text }}</p>
                    </article>
                </div>

                <form
                    class="agent-assistant-composer"
                    @submit.prevent="sendMessage()"
                >
                    <textarea
                        v-model="draft"
                        class="agent-assistant-input"
                        :placeholder="placeholderText"
                        rows="3"
                        :disabled="isSending"
                        @keydown.enter.exact.prevent="sendMessage()"
                    />
                    <div class="agent-assistant-composer-actions">
                        <UButton
                            v-if="isSending"
                            :label="t('assistant.stop')"
                            icon="i-ph-stop-circle"
                            color="neutral"
                            variant="outline"
                            size="sm"
                            @click="interrupt"
                        />
                        <UButton
                            :label="t('assistant.send')"
                            icon="i-ph-arrow-up"
                            color="primary"
                            size="sm"
                            type="submit"
                            :loading="isSending"
                            :disabled="!canSend"
                        />
                    </div>
                </form>
            </template>

            <p
                v-if="status.error"
                class="agent-assistant-error"
            >
                {{ status.error }}
            </p>
        </div>
    </aside>
</template>

<script setup lang="ts">
import type {
    IAgentAssistantEvent,
    IAgentAssistantState,
    TAgentAssistantLoginMode,
    TAgentAssistantMessageRole,
} from '@contracts/agent';
import { guardAsync } from '@app/utils/asyncGuard';
import { getPlatformAPI } from '@app/utils/platform';

const {
    activeDocumentName = null,
    hasActiveDocument = false,
    hasAnyDocument = false,
} = defineProps<{
    activeDocumentName?: string | null;
    hasActiveDocument?: boolean;
    hasAnyDocument?: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useTypedI18n();
const isRefreshing = ref(false);
const isInstalling = ref(false);
const isLoggingIn = ref(false);
const loginMode = ref<TAgentAssistantLoginMode | null>(null);
const isSending = ref(false);
const installProgress = ref('');
const deviceCode = ref('');
const draft = ref('');
const messagesRef = ref<HTMLElement | null>(null);
const state = ref<IAgentAssistantState | null>(null);

const emptyState = computed<IAgentAssistantState>(() => ({
    status: {
        supported: true,
        platform: '',
        installState: 'missing',
        codexInstalled: false,
        codexPath: null,
        codexVersion: null,
        minimumCodexVersion: '0.133.0',
        codexVersionSupported: false,
        installUrl: '',
        installScriptUrl: '',
        managedInstallDir: '',
        authState: 'unknown',
        account: null,
        runtimeState: 'stopped',
        mcp: {
            serverName: 'evb_viewer_embedded',
            serverUrl: '',
            serverRunning: false,
            toolCount: 0,
        },
        threadId: null,
        activeTurnId: null,
        lastCheckedAt: '',
    },
    messages: [],
}));
const status = computed(() => (state.value ?? emptyState.value).status);
const messages = computed(() => (state.value ?? emptyState.value).messages);
const canSend = computed(() => draft.value.trim().length > 0 && !isSending.value);
const signedInLabel = computed(() => {
    const account = status.value.account;
    if (account?.type === 'chatgpt' && account.email) {
        return t('assistant.signedInAs', { email: account.email });
    }
    return t('assistant.signedIn');
});
const toolsLabel = computed(() => t('assistant.connectedTools', { count: status.value.mcp.toolCount }));
const installButtonLabel = computed(() => isInstalling.value
    ? t('assistant.installingCodex')
    : t('assistant.installCodex'));
const emptyTitle = computed(() => hasActiveDocument
    ? t('assistant.emptyDocumentTitle')
    : t('assistant.emptyWorkspaceTitle'));
const emptyDescription = computed(() => {
    if (hasActiveDocument) {
        return activeDocumentName
            ? t('assistant.emptyDocumentDescriptionNamed', { name: activeDocumentName })
            : t('assistant.emptyDocumentDescription');
    }
    return hasAnyDocument
        ? t('assistant.emptyWorkspaceWithDocumentsDescription')
        : t('assistant.emptyWorkspaceDescription');
});
const placeholderText = computed(() => hasActiveDocument
    ? t('assistant.documentPlaceholder')
    : t('assistant.workspacePlaceholder'));

function applyState(nextState: IAgentAssistantState) {
    state.value = nextState;
    isSending.value = nextState.status.runtimeState === 'busy';
    void nextTick(() => {
        const el = messagesRef.value;
        if (el) {
            el.scrollTop = el.scrollHeight;
        }
    });
}

function handleAssistantEvent(event: IAgentAssistantEvent) {
    if (event.state) {
        applyState(event.state);
    }
    if (event.type === 'install-progress' && event.progress) {
        installProgress.value = event.progress;
    }
    if (event.type === 'error') {
        isInstalling.value = false;
        isLoggingIn.value = false;
        isSending.value = false;
    }
}

async function refreshState() {
    isRefreshing.value = true;
    try {
        applyState(await getPlatformAPI().agent.getAssistantState());
    } finally {
        isRefreshing.value = false;
    }
}

async function installCodex() {
    isInstalling.value = true;
    installProgress.value = '';
    try {
        const result = await getPlatformAPI().agent.installAssistantCodex();
        applyState(result.state);
    } finally {
        isInstalling.value = false;
    }
}

async function startLogin(mode: TAgentAssistantLoginMode) {
    isLoggingIn.value = true;
    loginMode.value = mode;
    deviceCode.value = '';
    try {
        const result = await getPlatformAPI().agent.startAssistantLogin({ mode });
        applyState(result.state);
        deviceCode.value = result.userCode ?? '';
    } finally {
        isLoggingIn.value = false;
        loginMode.value = null;
    }
}

async function cancelLogin() {
    applyState(await getPlatformAPI().agent.cancelAssistantLogin());
    deviceCode.value = '';
}

async function sendMessage() {
    if (!canSend.value) {
        return;
    }
    const text = draft.value.trim();
    draft.value = '';
    isSending.value = true;
    try {
        const result = await getPlatformAPI().agent.sendAssistantMessage({ text });
        applyState(result.state);
    } finally {
        isSending.value = status.value.runtimeState === 'busy';
    }
}

async function interrupt() {
    applyState(await getPlatformAPI().agent.interruptAssistant());
}

function roleLabel(role: TAgentAssistantMessageRole) {
    if (role === 'user') {
        return t('assistant.roleUser');
    }
    if (role === 'system') {
        return t('assistant.roleSystem');
    }
    return t('assistant.roleAssistant');
}

let unsubscribe: (() => void) | null = null;
onMounted(() => {
    unsubscribe = getPlatformAPI().agent.onAssistantEvent(handleAssistantEvent);
    guardAsync(refreshState(), {
        scope: 'assistant',
        message: 'Failed to load assistant state',
    });
});

onUnmounted(() => {
    unsubscribe?.();
    unsubscribe = null;
});
</script>

<style scoped>
.agent-assistant-panel {
    display: flex;
    flex-direction: column;
    flex: 0 0 min(24rem, 42vw);
    min-width: 20rem;
    max-width: 26rem;
    min-height: 0;
    border-left: 1px solid var(--ui-border);
    background: var(--ui-bg);
}

.agent-assistant-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    width: 100%;
    padding: 0.625rem 0.75rem;
    border-bottom: 1px solid var(--ui-border);
}

.agent-assistant-title,
.agent-assistant-header-actions,
.agent-assistant-setup-actions,
.agent-assistant-composer-actions,
.agent-assistant-status-line {
    display: flex;
    align-items: center;
}

.agent-assistant-title {
    gap: 0.45rem;
    min-width: 0;
    color: var(--ui-text);
    font-size: 0.875rem;
    font-weight: 600;
}

.agent-assistant-title-icon {
    width: 1rem;
    height: 1rem;
    color: var(--ui-primary);
}

.agent-assistant-header-actions,
.agent-assistant-setup-actions,
.agent-assistant-composer-actions {
    gap: 0.35rem;
}

.agent-assistant-body {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
}

.agent-assistant-setup {
    display: flex;
    min-height: 0;
    flex: 1 1 auto;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 0.75rem;
    padding: 1rem;
}

.agent-assistant-setup-icon,
.agent-assistant-empty-icon {
    width: 1.25rem;
    height: 1.25rem;
    color: var(--ui-primary);
}

.agent-assistant-setup h2,
.agent-assistant-empty h2 {
    margin: 0;
    color: var(--ui-text);
    font-size: 0.95rem;
    font-weight: 650;
}

.agent-assistant-setup p,
.agent-assistant-empty p,
.agent-assistant-message p,
.agent-assistant-progress,
.agent-assistant-error {
    margin: 0;
    color: var(--ui-text-muted);
    font-size: 0.8125rem;
    line-height: 1.45;
}

.agent-assistant-status-line {
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--ui-border);
    color: var(--ui-text-dimmed);
    font-size: 0.75rem;
}

.agent-assistant-messages {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    flex-direction: column;
    gap: 0.75rem;
    overflow: auto;
    padding: 0.75rem;
}

.agent-assistant-empty {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 0.65rem;
}

.agent-assistant-message {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-width: 92%;
}

.agent-assistant-message.is-user {
    align-self: flex-end;
}

.agent-assistant-message.is-assistant,
.agent-assistant-message.is-system {
    align-self: flex-start;
}

.agent-assistant-message-role {
    color: var(--ui-text-dimmed);
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
}

.agent-assistant-message p {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 0.55rem 0.65rem;
    border: 1px solid var(--ui-border);
    border-radius: var(--ui-radius);
    background: var(--ui-bg-elevated);
    color: var(--ui-text);
}

.agent-assistant-message.is-user p {
    background: var(--ui-primary);
    color: var(--ui-primary-fg);
}

.agent-assistant-message.is-system p,
.agent-assistant-error {
    color: var(--ui-error);
}

.agent-assistant-composer {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    border-top: 1px solid var(--ui-border);
}

.agent-assistant-input {
    width: 100%;
    min-height: 4.5rem;
    resize: vertical;
    padding: 0.55rem 0.65rem;
    border: 1px solid var(--ui-border);
    border-radius: var(--ui-radius);
    background: var(--ui-bg);
    color: var(--ui-text);
    font: inherit;
    font-size: 0.8125rem;
    line-height: 1.45;
    outline: none;
}

.agent-assistant-input:focus {
    border-color: var(--ui-primary);
}

.agent-assistant-input:disabled {
    color: var(--ui-text-dimmed);
}

.agent-assistant-composer-actions {
    justify-content: flex-end;
}

.agent-assistant-device-code {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--ui-border);
    border-radius: var(--ui-radius);
    color: var(--ui-text);
    font-size: 0.8125rem;
}

.agent-assistant-device-code strong {
    letter-spacing: 0;
}

.agent-assistant-error {
    padding: 0 0.75rem 0.75rem;
}

@media (width <= 50rem) {
    .agent-assistant-panel {
        position: absolute;
        inset: 2.5rem 0 0 auto;
        z-index: 30;
        width: min(100vw, 24rem);
        max-width: none;
        box-shadow: var(--app-pdf-context-menu-panel-shadow);
    }
}
</style>
