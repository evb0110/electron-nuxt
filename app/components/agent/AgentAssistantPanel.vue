<template>
    <aside
        class="agent-assistant-panel"
        :aria-label="t('assistant.title')"
    >
        <header class="agent-assistant-header">
            <div class="agent-assistant-title">
                <UIcon name="i-ph-chat-circle-dots" class="agent-assistant-title-icon" />
            </div>
            <div class="agent-assistant-header-actions">
                <UButton
                    :aria-label="t('assistant.newChat')"
                    icon="i-ph-plus"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    :loading="isResetting"
                    :disabled="!canResetChat"
                    @click="resetChat"
                />
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
                v-if="panelView === 'checking'"
                class="agent-assistant-setup"
            >
                <UIcon name="i-ph-circle-notch" class="agent-assistant-setup-icon is-spinning" />
                <h2>{{ t('assistant.checkingTitle') }}</h2>
                <p>{{ t('assistant.checkingDescription') }}</p>
            </section>

            <section
                v-else-if="panelView === 'unsupported'"
                class="agent-assistant-setup"
            >
                <UIcon name="i-ph-warning-circle" class="agent-assistant-setup-icon" />
                <h2>{{ t('assistant.unsupportedTitle') }}</h2>
                <p>{{ t('assistant.unsupportedDescription') }}</p>
            </section>

            <section
                v-else-if="panelView === 'install'"
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
                v-else-if="panelView === 'update'"
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
                v-else-if="panelView === 'sign-in'"
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

            <template v-else-if="panelView === 'ready'">
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
                        :class="[
                            `is-${message.role}`,
                            { 'is-pending': message.pending },
                        ]"
                        :aria-label="roleLabel(message.role)"
                    >
                        <div
                            v-if="message.attachments?.length"
                            class="agent-assistant-message-attachments"
                        >
                            <img
                                v-for="attachment in message.attachments"
                                :key="attachment.id"
                                class="agent-assistant-message-image"
                                :src="attachment.dataUrl"
                                :alt="attachment.name"
                            >
                        </div>
                        <p v-if="message.text || message.pending">
                            {{ message.text || (message.pending ? t('assistant.working') : '') }}
                        </p>
                    </article>

                    <div
                        v-if="isTurnActive"
                        class="agent-assistant-turn-progress"
                    >
                        <UIcon name="i-ph-circle-notch" class="agent-assistant-working-icon is-spinning" />
                        <span>{{ turnStatusText }}</span>
                    </div>
                </div>

                <form
                    class="agent-assistant-composer"
                    @submit.prevent="sendMessage()"
                >
                    <div class="agent-assistant-composer-field">
                        <div
                            v-if="composerImages.length > 0"
                            class="agent-assistant-composer-attachments"
                            :aria-label="t('assistant.imageAttachments')"
                        >
                            <div
                                v-for="image in composerImages"
                                :key="image.id"
                                class="agent-assistant-composer-attachment"
                            >
                                <img
                                    class="agent-assistant-composer-attachment-image"
                                    :src="image.dataUrl"
                                    :alt="image.name"
                                >
                                <UButton
                                    class="agent-assistant-composer-attachment-remove"
                                    :aria-label="t('assistant.removeImageAttachment', { name: image.name })"
                                    icon="i-ph-x"
                                    color="neutral"
                                    variant="solid"
                                    size="xs"
                                    type="button"
                                    @click="removeComposerImage(image.id)"
                                />
                            </div>
                        </div>
                        <p
                            v-if="composerError"
                            class="agent-assistant-composer-error"
                        >
                            {{ composerError }}
                        </p>
                        <textarea
                            v-model="draft"
                            class="agent-assistant-input"
                            :placeholder="placeholderText"
                            rows="3"
                            :disabled="isSending"
                            @keydown.enter.exact.prevent="sendMessage()"
                            @paste="handleComposerPaste"
                        />
                        <div class="agent-assistant-composer-actions">
                            <UButton
                                v-if="isSending"
                                :aria-label="t('assistant.stop')"
                                icon="i-ph-stop-circle"
                                color="neutral"
                                variant="outline"
                                size="sm"
                                @click="interrupt"
                            />
                            <UButton
                                v-else
                                :aria-label="t('assistant.send')"
                                icon="i-ph-arrow-up"
                                :color="canSend ? 'primary' : 'neutral'"
                                :variant="canSend ? 'solid' : 'soft'"
                                size="sm"
                                type="submit"
                                :disabled="!canSend"
                            />
                        </div>
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
    IAgentAssistantImageAttachment,
    IAgentAssistantState,
    TAgentAssistantLoginMode,
    TAgentAssistantMessageRole,
} from '@contracts/agent';
import { getAgentAssistantPanelView } from '@app/components/agent/agentAssistantPanelState';
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
const ASSISTANT_MAX_IMAGE_ATTACHMENTS = 8;
const ASSISTANT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ASSISTANT_IMAGE_SIZE_LIMIT_LABEL = `${Math.round(ASSISTANT_MAX_IMAGE_BYTES / (1024 * 1024))} MB`;
const isRefreshing = ref(false);
const isInstalling = ref(false);
const isLoggingIn = ref(false);
const loginMode = ref<TAgentAssistantLoginMode | null>(null);
const isSending = ref(false);
const isResetting = ref(false);
const hasLoadedState = ref(false);
const installProgress = ref('');
const deviceCode = ref('');
const draft = ref('');
const composerImages = ref<IAgentAssistantImageAttachment[]>([]);
const composerError = ref('');
const messagesRef = ref<HTMLElement | null>(null);
const state = ref<IAgentAssistantState | null>(null);
let sendGeneration = 0;

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
        turn: {
            id: null,
            phase: 'idle',
        },
        threadId: null,
        activeTurnId: null,
        lastCheckedAt: '',
    },
    messages: [],
}));
const status = computed(() => (state.value ?? emptyState.value).status);
const messages = computed(() => (state.value ?? emptyState.value).messages);
const panelView = computed(() => getAgentAssistantPanelView(status.value, hasLoadedState.value));
const canSend = computed(() => (
    (draft.value.trim().length > 0 || composerImages.value.length > 0)
    && !isSending.value
));
const canResetChat = computed(() => (
    hasLoadedState.value
    && !isResetting.value
    && (
        messages.value.length > 0
        || Boolean(status.value.threadId)
        || status.value.runtimeState === 'busy'
    )
));
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
const isTurnActive = computed(() => (
    status.value.turn.phase === 'starting'
    || status.value.turn.phase === 'running'
    || status.value.turn.phase === 'interrupting'
    || status.value.runtimeState === 'busy'
));
const turnStatusText = computed(() => {
    if (status.value.turn.phase === 'interrupting') {
        return t('assistant.interrupting');
    }
    if (status.value.turn.phase === 'starting') {
        return t('assistant.startingTurn');
    }
    return t('assistant.working');
});

function applyState(nextState: IAgentAssistantState) {
    state.value = nextState;
    hasLoadedState.value = true;
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

function createAttachmentId() {
    return globalThis.crypto?.randomUUID?.() ?? `image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function fallbackImageName(index: number) {
    return t('assistant.imageAttachmentFallbackName', { count: index + 1 });
}

function normalizeImageName(file: File, index: number) {
    return file.name.trim() || fallbackImageName(index);
}

function isImageFile(file: File | null): file is File {
    return Boolean(file?.type?.toLowerCase().startsWith('image/'));
}

function getClipboardImageFiles(dataTransfer: DataTransfer | null) {
    if (!dataTransfer) {
        return [];
    }

    const directFiles = Array.from(dataTransfer.files).filter(isImageFile);
    if (directFiles.length > 0) {
        return directFiles;
    }

    return Array.from(dataTransfer.items)
        .flatMap(item => (
            item.kind === 'file' && item.type.toLowerCase().startsWith('image/')
                ? [item.getAsFile()]
                : []
        ))
        .filter(isImageFile);
}

function readFileAsDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Failed to read image'));
        reader.onload = () => {
            if (typeof reader.result === 'string' && reader.result.startsWith('data:image/')) {
                resolve(reader.result);
                return;
            }
            reject(new Error('Invalid image data'));
        };
        reader.readAsDataURL(file);
    });
}

async function addComposerImages(files: File[]) {
    if (files.length === 0 || isSending.value) {
        return;
    }

    const nextImages = [...composerImages.value];
    let nextError = '';
    for (const file of files) {
        const name = normalizeImageName(file, nextImages.length);
        if (!isImageFile(file)) {
            nextError = t('assistant.imageUnsupported', { name });
            continue;
        }
        if (file.size <= 0 || file.size > ASSISTANT_MAX_IMAGE_BYTES) {
            nextError = t('assistant.imageTooLarge', {
                name,
                size: ASSISTANT_IMAGE_SIZE_LIMIT_LABEL,
            });
            continue;
        }
        if (nextImages.length >= ASSISTANT_MAX_IMAGE_ATTACHMENTS) {
            nextError = t('assistant.imageAttachmentLimit', { count: ASSISTANT_MAX_IMAGE_ATTACHMENTS });
            break;
        }

        try {
            nextImages.push({
                type: 'image',
                id: createAttachmentId(),
                name,
                mimeType: file.type.toLowerCase(),
                sizeBytes: file.size,
                dataUrl: await readFileAsDataUrl(file),
            });
        } catch {
            nextError = t('assistant.imageReadFailed', { name });
        }
    }

    composerImages.value = nextImages;
    composerError.value = nextError;
}

function handleComposerPaste(event: ClipboardEvent) {
    const imageFiles = getClipboardImageFiles(event.clipboardData);
    if (imageFiles.length === 0) {
        return;
    }

    event.preventDefault();
    void addComposerImages(imageFiles);
}

function removeComposerImage(imageId: string) {
    composerImages.value = composerImages.value.filter(image => image.id !== imageId);
    composerError.value = '';
}

async function sendMessage() {
    if (!canSend.value) {
        return;
    }
    const generation = sendGeneration;
    const text = draft.value.trim();
    const attachments = composerImages.value.map(image => ({ ...image }));
    draft.value = '';
    composerImages.value = [];
    composerError.value = '';
    isSending.value = true;
    try {
        const result = await getPlatformAPI().agent.sendAssistantMessage({
            text,
            ...(attachments.length > 0 ? { attachments } : {}),
        });
        if (generation !== sendGeneration) {
            return;
        }
        applyState(result.state);
    } finally {
        if (generation === sendGeneration) {
            isSending.value = status.value.runtimeState === 'busy';
        }
    }
}

async function interrupt() {
    sendGeneration += 1;
    applyState(await getPlatformAPI().agent.interruptAssistant());
}

async function resetChat() {
    sendGeneration += 1;
    draft.value = '';
    composerImages.value = [];
    composerError.value = '';
    isResetting.value = true;
    try {
        applyState(await getPlatformAPI().agent.resetAssistantChat());
    } finally {
        isResetting.value = false;
        isSending.value = status.value.runtimeState === 'busy';
    }
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
.agent-assistant-turn-progress {
    display: flex;
    align-items: center;
}

.agent-assistant-title {
    gap: 0.45rem;
    min-width: 0;
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

.is-spinning {
    animation: agent-assistant-spin 0.9s linear infinite;
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
.agent-assistant-turn-progress,
.agent-assistant-composer-error,
.agent-assistant-progress,
.agent-assistant-error {
    margin: 0;
    color: var(--ui-text-muted);
    font-size: 0.8125rem;
    line-height: 1.45;
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

.agent-assistant-message-attachments {
    display: flex;
    max-width: 100%;
    flex-wrap: wrap;
    gap: 0.35rem;
}

.agent-assistant-message.is-user .agent-assistant-message-attachments {
    justify-content: flex-end;
}

.agent-assistant-message-image {
    display: block;
    width: 4.5rem;
    height: 4.5rem;
    border: 1px solid var(--ui-border);
    border-radius: var(--ui-radius);
    background: var(--ui-bg-muted);
    object-fit: cover;
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

.agent-assistant-message.is-pending p {
    border-color: color-mix(in oklab, var(--ui-primary) 34%, var(--ui-border) 66%);
}

.agent-assistant-turn-progress {
    gap: 0.35rem;
    color: var(--ui-text-dimmed);
    font-size: 0.75rem;
}

.agent-assistant-turn-progress {
    align-self: flex-start;
    padding: 0.45rem 0.55rem;
    border: 1px solid var(--ui-border);
    border-radius: var(--ui-radius);
    background: var(--ui-bg-elevated);
}

.agent-assistant-working-icon {
    width: 0.875rem;
    height: 0.875rem;
    flex: 0 0 auto;
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
    padding: 0.75rem;
    border-top: 1px solid var(--ui-border);
}

.agent-assistant-composer-field {
    position: relative;
}

.agent-assistant-composer-attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.5rem;
    padding-right: 2.75rem;
}

.agent-assistant-composer-attachment {
    position: relative;
    width: 3.75rem;
    height: 3.75rem;
    flex: 0 0 auto;
    overflow: hidden;
    border: 1px solid var(--ui-border);
    border-radius: var(--ui-radius);
    background: var(--ui-bg-muted);
}

.agent-assistant-composer-attachment-image {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.agent-assistant-composer-attachment-remove {
    position: absolute;
    top: 0.2rem;
    right: 0.2rem;
}

.agent-assistant-composer-error {
    margin-bottom: 0.5rem;
    color: var(--ui-error);
}

.agent-assistant-input {
    display: block;
    width: 100%;
    min-height: 4.5rem;
    resize: none;
    padding: 0.55rem 2.75rem 0.55rem 0.65rem;
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
    position: absolute;
    right: 0.5rem;
    bottom: 0.5rem;
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

@keyframes agent-assistant-spin {
    to {
        transform: rotate(360deg);
    }
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
