<template>
    <aside
        class="agent-assistant-panel"
        :style="{ '--assistant-panel-width': widthVar }"
        :aria-label="t('assistant.title')"
    >
        <div
            class="agent-assistant-resizer"
            :class="{ 'is-active': isResizing }"
            role="separator"
            aria-orientation="vertical"
            :aria-label="t('sidebar.resize')"
            @pointerdown.prevent="emit('resize-start', $event)"
        />

        <header class="agent-assistant-header">
            <span class="agent-assistant-title">
                <UIcon :name="headerIcon" class="agent-assistant-title-icon" />
                <AppTooltip
                    :text="headerTitle"
                    :delay-duration="300"
                    usefulness="overflow"
                >
                    <span class="agent-assistant-title-text">{{ headerTitle }}</span>
                </AppTooltip>
            </span>
            <div class="agent-assistant-header-actions">
                <AppTooltip :text="t('assistant.newChat')" :delay-duration="300">
                    <UButton
                        class="agent-assistant-header-button"
                        :aria-label="t('assistant.newChat')"
                        icon="i-ph-plus"
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        :loading="isResetting"
                        :disabled="!canResetChat"
                        @click="resetChat"
                    />
                </AppTooltip>
                <AppTooltip :text="t('assistant.close')" :delay-duration="300">
                    <UButton
                        class="agent-assistant-header-button"
                        :aria-label="t('assistant.close')"
                        icon="i-ph-x"
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        @click="emit('close')"
                    />
                </AppTooltip>
            </div>
        </header>

        <div class="agent-assistant-body">
            <section
                v-if="panelView === 'checking'"
                class="agent-assistant-placeholder"
            >
                <span class="agent-assistant-glyph">
                    <UIcon name="i-ph-circle-notch" class="agent-assistant-glyph-icon is-spinning" />
                </span>
                <h2>{{ t('assistant.checkingTitle') }}</h2>
                <p>{{ t('assistant.checkingDescription') }}</p>
            </section>

            <section
                v-else-if="panelView === 'unsupported'"
                class="agent-assistant-placeholder"
            >
                <span class="agent-assistant-glyph">
                    <UIcon name="i-ph-warning-circle" class="agent-assistant-glyph-icon" />
                </span>
                <h2>{{ t('assistant.unsupportedTitle') }}</h2>
                <p>{{ t('assistant.unsupportedDescription') }}</p>
            </section>

            <section
                v-else-if="panelView === 'install'"
                class="agent-assistant-placeholder"
            >
                <span class="agent-assistant-glyph">
                    <UIcon name="i-ph-download-simple" class="agent-assistant-glyph-icon" />
                </span>
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
                class="agent-assistant-placeholder"
            >
                <span class="agent-assistant-glyph">
                    <UIcon name="i-ph-warning-circle" class="agent-assistant-glyph-icon" />
                </span>
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
                class="agent-assistant-placeholder"
            >
                <span class="agent-assistant-glyph">
                    <UIcon name="i-ph-chat-circle-dots" class="agent-assistant-glyph-icon" />
                </span>
                <h2>{{ t('assistant.signInTitle') }}</h2>
                <p>{{ t('assistant.signInDescription') }}</p>
                <div class="agent-assistant-placeholder-actions">
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
                <section
                    v-if="!chatScope"
                    class="agent-assistant-placeholder"
                >
                    <span class="agent-assistant-glyph">
                        <UIcon name="i-ph-file-text" class="agent-assistant-glyph-icon" />
                    </span>
                    <h2>{{ t('assistant.noDocumentTitle') }}</h2>
                    <p>{{ t('assistant.noDocumentDescription') }}</p>
                </section>

                <template v-else>
                    <section
                        v-if="!hasMessages"
                        class="agent-assistant-placeholder"
                    >
                        <span class="agent-assistant-glyph">
                            <UIcon name="i-ph-lightbulb" class="agent-assistant-glyph-icon" />
                        </span>
                        <h2>{{ emptyTitle }}</h2>
                        <p>{{ emptyDescription }}</p>
                    </section>

                    <div
                        v-else
                        ref="messagesRef"
                        class="agent-assistant-messages"
                    >
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
                                <button
                                    v-for="attachment in message.attachments"
                                    :key="attachment.id"
                                    class="agent-assistant-message-image-button"
                                    type="button"
                                    :aria-label="t('assistant.previewImage', { name: attachment.name })"
                                    @click="expandImage(message.attachments, attachment.id)"
                                >
                                    <img
                                        class="agent-assistant-message-image"
                                        :src="attachment.dataUrl"
                                        :alt="attachment.name"
                                        draggable="false"
                                    >
                                </button>
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
                                    <button
                                        class="agent-assistant-composer-attachment-preview"
                                        type="button"
                                        :aria-label="t('assistant.previewImage', { name: image.name })"
                                        @click="expandImage(composerImages, image.id)"
                                    >
                                        <img
                                            class="agent-assistant-composer-attachment-image"
                                            :src="image.dataUrl"
                                            :alt="image.name"
                                            draggable="false"
                                        >
                                    </button>
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
            </template>

            <div
                v-if="!hasComposer"
                class="agent-assistant-composer agent-assistant-composer-reserve"
                aria-hidden="true"
            >
                <div class="agent-assistant-composer-field">
                    <textarea
                        class="agent-assistant-input"
                        rows="3"
                        tabindex="-1"
                        disabled
                    />
                </div>
            </div>

            <p
                v-if="status.error"
                class="agent-assistant-error"
            >
                {{ status.error }}
            </p>
        </div>
    </aside>

    <Teleport to="body">
        <div
            v-if="expandedImage"
            class="agent-assistant-image-preview"
            role="dialog"
            aria-modal="true"
            :aria-label="t('assistant.expandedImagePreview')"
        >
            <button
                class="agent-assistant-image-preview-backdrop"
                type="button"
                :aria-label="t('assistant.closeImagePreview')"
                @click="closeExpandedImage"
            />
            <UButton
                v-if="expandedImage.images.length > 1"
                class="agent-assistant-image-preview-nav is-previous"
                :aria-label="t('assistant.previousImage')"
                icon="i-ph-caret-left"
                color="neutral"
                variant="soft"
                size="lg"
                type="button"
                @click="navigateExpandedImage(-1)"
            />
            <figure class="agent-assistant-image-preview-content">
                <UButton
                    class="agent-assistant-image-preview-close"
                    :aria-label="t('assistant.closeImagePreview')"
                    icon="i-ph-x"
                    color="neutral"
                    variant="solid"
                    size="sm"
                    type="button"
                    @click="closeExpandedImage"
                />
                <img
                    class="agent-assistant-image-preview-image"
                    :src="expandedImageItem?.src"
                    :alt="expandedImageItem?.name ?? ''"
                    draggable="false"
                >
                <AppTooltip
                    v-if="expandedImageItem"
                    :text="expandedImageCaption"
                    :delay-duration="300"
                    usefulness="overflow"
                >
                    <figcaption class="agent-assistant-image-preview-caption">
                        {{ expandedImageCaption }}
                    </figcaption>
                </AppTooltip>
            </figure>
            <UButton
                v-if="expandedImage.images.length > 1"
                class="agent-assistant-image-preview-nav is-next"
                :aria-label="t('assistant.nextImage')"
                icon="i-ph-caret-right"
                color="neutral"
                variant="soft"
                size="lg"
                type="button"
                @click="navigateExpandedImage(1)"
            />
        </div>
    </Teleport>
</template>

<script setup lang="ts">
import type {
    IAgentAssistantChatScope,
    IAgentAssistantEvent,
    IAgentAssistantImageAttachment,
    IAgentAssistantState,
    TAgentAssistantLoginMode,
    TAgentAssistantMessageRole,
} from '@contracts/agent';
import { getAgentAssistantPanelView } from '@app/modules/workspace-shell/public';
import { guardAsync } from '@app/utils/asyncGuard';
import { getPlatformAPI } from '@app/utils/platform';
import {
    defaultDocument,
    defaultWindow,
    useEventListener,
} from '@vueuse/core';

const {
    activeDocumentName = null,
    chatScope = null,
    hasActiveDocument = false,
    hasAnyDocument = false,
    width = undefined,
    isResizing = false,
} = defineProps<{
    activeDocumentName?: string | null;
    chatScope?: IAgentAssistantChatScope | null;
    hasActiveDocument?: boolean;
    hasAnyDocument?: boolean;
    width?: number | undefined;
    isResizing?: boolean;
}>();

const emit = defineEmits<{
    close: [];
    'resize-start': [event: PointerEvent];
}>();

const widthVar = computed(() => (width != null ? `${width}px` : undefined));

const { t } = useTypedI18n();
const ASSISTANT_MAX_IMAGE_ATTACHMENTS = 8;
const ASSISTANT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ASSISTANT_IMAGE_SIZE_LIMIT_LABEL = `${Math.round(ASSISTANT_MAX_IMAGE_BYTES / (1024 * 1024))} MB`;
const ASSISTANT_AUTO_REFRESH_MIN_INTERVAL_MS = 2500;
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
let stateGeneration = 0;
let lastRefreshStartedAt = 0;

interface IExpandedImageItem {
    src: string;
    name: string;
}

interface IExpandedImagePreview {
    images: IExpandedImageItem[];
    index: number;
}

const emptyState = computed<IAgentAssistantState>(() => ({
    scope: chatScope ? cloneAssistantScope(chatScope) : null,
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
const hasComposer = computed(() => panelView.value === 'ready' && Boolean(chatScope));
const hasMessages = computed(() => messages.value.length > 0 || isTurnActive.value);
const canSend = computed(() => (
    Boolean(chatScope)
    &&
    (draft.value.trim().length > 0 || composerImages.value.length > 0)
    && !isSending.value
));
const canResetChat = computed(() => (
    hasLoadedState.value
    && Boolean(chatScope)
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
const headerIcon = computed(() => (chatScope?.title ? 'i-ph-file-text' : 'i-ph-chat-circle-dots'));
const headerTitle = computed(() => chatScope?.title ?? t('assistant.title'));
const isTurnActive = computed(() => (
    status.value.turn.phase === 'starting'
    || status.value.turn.phase === 'running'
    || status.value.turn.phase === 'interrupting'
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
const expandedImage = ref<IExpandedImagePreview | null>(null);
const expandedImageItem = computed(() => {
    const preview = expandedImage.value;
    return preview?.images[preview.index] ?? null;
});
const expandedImageCaption = computed(() => {
    const preview = expandedImage.value;
    const item = expandedImageItem.value;
    if (!preview || !item) {
        return '';
    }
    if (preview.images.length <= 1) {
        return item.name;
    }
    return t('assistant.imagePreviewPosition', {
        name: item.name,
        current: preview.index + 1,
        total: preview.images.length,
    });
});

function cloneAssistantScope(scope: IAgentAssistantChatScope): IAgentAssistantChatScope {
    return {
        kind: scope.kind,
        key: scope.key,
        title: scope.title,
        ...(scope.tabId == null ? {} : { tabId: scope.tabId }),
        ...(scope.documentRef == null ? {} : { documentRef: scope.documentRef }),
    };
}

function createAssistantStateRequest() {
    return { scope: chatScope ? cloneAssistantScope(chatScope) : null };
}

function getStateScopeKey(nextState: IAgentAssistantState) {
    return nextState.scope?.key ?? null;
}

function isCurrentScopeState(nextState: IAgentAssistantState) {
    return getStateScopeKey(nextState) === (chatScope?.key ?? null);
}

function applyState(nextState: IAgentAssistantState) {
    if (!isCurrentScopeState(nextState)) {
        return;
    }
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
    const generation = ++stateGeneration;
    lastRefreshStartedAt = Date.now();
    const nextState = await getPlatformAPI().agent.getAssistantState(createAssistantStateRequest());
    if (generation === stateGeneration) {
        applyState(nextState);
    }
}

function refreshStateAfterWindowReturn() {
    if (document.visibilityState === 'hidden') {
        return;
    }

    const now = Date.now();
    if (now - lastRefreshStartedAt < ASSISTANT_AUTO_REFRESH_MIN_INTERVAL_MS) {
        return;
    }

    guardAsync(refreshState(), {
        scope: 'assistant',
        message: 'Failed to refresh assistant state after app focus',
    });
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

function buildExpandedImagePreview(
    images: readonly IAgentAssistantImageAttachment[],
    selectedImageId: string,
): IExpandedImagePreview | null {
    const previewableImages = images
        .filter(image => image.dataUrl.startsWith('data:image/'))
        .map(image => ({
            id: image.id,
            src: image.dataUrl,
            name: image.name,
        }));
    if (previewableImages.length === 0) {
        return null;
    }
    const selectedIndex = previewableImages.findIndex(image => image.id === selectedImageId);
    if (selectedIndex < 0) {
        return null;
    }
    return {
        images: previewableImages.map(image => ({
            src: image.src,
            name: image.name,
        })),
        index: selectedIndex,
    };
}

function expandImage(images: readonly IAgentAssistantImageAttachment[] | undefined, selectedImageId: string) {
    if (!images) {
        return;
    }
    expandedImage.value = buildExpandedImagePreview(images, selectedImageId);
}

function closeExpandedImage() {
    expandedImage.value = null;
}

function navigateExpandedImage(direction: -1 | 1) {
    const preview = expandedImage.value;
    if (!preview || preview.images.length <= 1) {
        return;
    }
    expandedImage.value = {
        ...preview,
        index: (preview.index + direction + preview.images.length) % preview.images.length,
    };
}

function handleExpandedImageKeydown(event: KeyboardEvent) {
    if (!expandedImage.value) {
        return;
    }
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeExpandedImage();
        return;
    }
    if (event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        navigateExpandedImage(-1);
        return;
    }
    if (event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        navigateExpandedImage(1);
    }
}

async function sendMessage() {
    if (!canSend.value) {
        return;
    }
    if (!chatScope) {
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
            scope: cloneAssistantScope(chatScope),
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
    if (!chatScope) {
        return;
    }
    sendGeneration += 1;
    applyState(await getPlatformAPI().agent.interruptAssistant(createAssistantStateRequest()));
}

async function resetChat() {
    if (!chatScope) {
        return;
    }
    sendGeneration += 1;
    draft.value = '';
    composerImages.value = [];
    composerError.value = '';
    isResetting.value = true;
    try {
        applyState(await getPlatformAPI().agent.resetAssistantChat(createAssistantStateRequest()));
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

watch(() => chatScope?.key ?? null, () => {
    stateGeneration += 1;
    sendGeneration += 1;
    state.value = null;
    hasLoadedState.value = false;
    draft.value = '';
    composerImages.value = [];
    composerError.value = '';
    isSending.value = false;
    guardAsync(refreshState(), {
        scope: 'assistant',
        message: 'Failed to refresh assistant state for document',
    });
});

let unsubscribe: (() => void) | null = null;
onMounted(() => {
    unsubscribe = getPlatformAPI().agent.onAssistantEvent(handleAssistantEvent);
    guardAsync(refreshState(), {
        scope: 'assistant',
        message: 'Failed to load assistant state',
    });
});

useEventListener(defaultWindow, 'focus', refreshStateAfterWindowReturn);
useEventListener(defaultDocument, 'visibilitychange', refreshStateAfterWindowReturn);
useEventListener(defaultWindow, 'keydown', handleExpandedImageKeydown);

onUnmounted(() => {
    unsubscribe?.();
    unsubscribe = null;
});
</script>

<style scoped>
.agent-assistant-panel {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 0 0 var(--assistant-panel-width, 24rem);
    width: var(--assistant-panel-width, 24rem);
    min-width: 0;
    min-height: 0;
    border-left: 1px solid var(--ui-border);
    background: var(--app-sidebar-bg);
}

.agent-assistant-resizer {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: 2;
    width: var(--app-editor-sash-size, 6px);
    cursor: col-resize;
    user-select: none;
    touch-action: none;
    background: transparent;
    border-left: 1px solid transparent;
    transition: border-color 0.15s ease;
    -webkit-app-region: no-drag;
}

.agent-assistant-resizer:hover,
.agent-assistant-resizer.is-active {
    border-left-color: var(--ui-primary);
}

.agent-assistant-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    width: 100%;
    height: var(--app-tabbar-height);
    min-height: var(--app-tabbar-height);
    padding: 0 0.5rem 0 0.75rem;
    border-bottom: 1px solid var(--ui-border);
    background: var(--app-tabbar-bg);
    -webkit-app-region: drag;
}

.agent-assistant-title {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
}

.agent-assistant-title-icon {
    flex: 0 0 auto;
    width: 1.05rem;
    height: 1.05rem;
    color: var(--ui-text-muted);
}

.agent-assistant-title-text {
    overflow: hidden;
    color: var(--ui-text);
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.agent-assistant-header-actions {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 0.25rem;
    -webkit-app-region: no-drag;
}

.agent-assistant-header-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    min-width: 1.75rem;
    height: 1.75rem;
    min-height: 1.75rem;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 0.375rem;
    color: var(--ui-text-muted);
    transition:
        background-color 0.12s ease,
        border-color 0.12s ease,
        color 0.12s ease,
        box-shadow 0.12s ease;
}

.agent-assistant-header-button:hover:not(:disabled) {
    background: var(--app-sidebar-control-hover-bg);
    color: var(--ui-text);
}

.agent-assistant-header-button:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
}

.agent-assistant-header-button:disabled {
    opacity: var(--app-toolbar-control-disabled-opacity);
    color: var(--app-toolbar-control-disabled-fg);
}

.agent-assistant-body {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    flex-direction: column;

    /* The app locks user-select globally; opt the assistant content back in so
       answers, setup copy, and device codes can be selected and copied. */
    user-select: text;
}

.agent-assistant-placeholder {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    flex-direction: column;
    align-items: flex-start;
    justify-content: flex-start;
    gap: 0.65rem;
    padding: 1.25rem;
}

/* Anchor the icon + title at a stable fraction of the panel height instead of
   centering the whole block, so the placeholder does not shift vertically when
   the muted description wraps to a different number of lines (1 line while
   checking vs. several once ready). Longer copy extends downward from here. */
.agent-assistant-placeholder::before {
    content: "";
    flex: 0 1 38%;
}

.agent-assistant-glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    border: 1px solid var(--ui-border);
    border-radius: 999px;
    background: var(--ui-bg);
}

.agent-assistant-glyph-icon {
    width: 1.25rem;
    height: 1.25rem;
    color: var(--ui-primary);
}

.is-spinning {
    animation: agent-assistant-spin 0.9s linear infinite;
}

.agent-assistant-placeholder h2 {
    margin: 0;
    color: var(--ui-text);
    font-size: 0.95rem;
    font-weight: 650;
    letter-spacing: -0.01em;
}

.agent-assistant-placeholder p,
.agent-assistant-message p,
.agent-assistant-progress {
    margin: 0;
    color: var(--ui-text-muted);
    font-size: 0.8125rem;
    line-height: 1.5;
}

.agent-assistant-placeholder-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
}

.agent-assistant-messages {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    flex-direction: column;
    gap: 0.625rem;
    overflow: auto;
    padding: 0.875rem;
    scroll-behavior: smooth;
}

.agent-assistant-message {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    max-width: 88%;
}

.agent-assistant-message.is-user {
    align-self: flex-end;
    align-items: flex-end;
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
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.agent-assistant-message-image-button {
    display: block;
    width: 4.5rem;
    height: 4.5rem;
    padding: 0;
    overflow: hidden;
    border: 1px solid var(--ui-border);
    border-radius: var(--ui-radius);
    background: var(--ui-bg-muted);
    cursor: zoom-in;
}

.agent-assistant-message p {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--ui-border);
    border-radius: 0.9rem;
    background: var(--ui-bg);
    color: var(--ui-text);
}

.agent-assistant-message.is-assistant p {
    border-bottom-left-radius: 0.3rem;
}

.agent-assistant-message.is-user p {
    border-color: transparent;
    border-bottom-right-radius: 0.3rem;
    background: var(--ui-primary);
    color: var(--ui-primary-fg);
}

.agent-assistant-message.is-system p {
    border-color: color-mix(in oklab, var(--ui-error) 30%, var(--ui-border) 70%);
    background: color-mix(in oklab, var(--ui-error) 8%, var(--ui-bg) 92%);
    color: var(--ui-error);
}

.agent-assistant-message.is-pending p {
    border-color: color-mix(in oklab, var(--ui-primary) 34%, var(--ui-border) 66%);
}

.agent-assistant-turn-progress {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    gap: 0.4rem;
    padding: 0.4rem 0.65rem;
    border: 1px solid var(--ui-border);
    border-radius: 999px;
    background: var(--ui-bg);
    color: var(--ui-text-dimmed);
    font-size: 0.75rem;
}

.agent-assistant-working-icon {
    width: 0.875rem;
    height: 0.875rem;
    flex: 0 0 auto;
}

.agent-assistant-composer {
    padding: 0.75rem;
    border-top: 1px solid var(--ui-border);
}

/* Reuses the composer markup so the reserved footer is byte-for-byte the same
   height as the real composer; visibility:hidden keeps the space but paints
   nothing, so the placeholder above it never shifts when the composer appears. */
.agent-assistant-composer-reserve {
    visibility: hidden;
}

.agent-assistant-composer-field {
    position: relative;
    border: 1px solid var(--ui-border);
    border-radius: 0.85rem;
    background: var(--ui-bg);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.agent-assistant-composer-field:focus-within {
    border-color: var(--ui-primary);
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--ui-primary) 18%, transparent);
}

.agent-assistant-composer-attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    padding: 0.5rem 0.5rem 0;
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

.agent-assistant-composer-attachment-preview {
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: zoom-in;
}

.agent-assistant-composer-attachment-remove {
    position: absolute;
    top: 0.2rem;
    right: 0.2rem;
    z-index: 1;
}

.agent-assistant-composer-error {
    margin: 0;
    padding: 0.4rem 0.7rem 0;
    color: var(--ui-error);
    font-size: 0.8125rem;
    line-height: 1.45;
}

.agent-assistant-input {
    display: block;
    width: 100%;
    min-height: 4.25rem;
    resize: none;
    padding: 0.55rem 2.75rem 0.55rem 0.7rem;
    border: 0;
    border-radius: 0.85rem;
    background: transparent;
    color: var(--ui-text);
    font: inherit;
    font-size: 0.8125rem;
    line-height: 1.5;
    outline: none;
}

.agent-assistant-input:disabled {
    color: var(--ui-text-dimmed);
}

.agent-assistant-composer-actions {
    position: absolute;
    right: 0.4rem;
    bottom: 0.4rem;
    display: flex;
    align-items: center;
    gap: 0.35rem;
}

.agent-assistant-device-code {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--ui-border);
    border-radius: var(--ui-radius);
    background: var(--ui-bg);
    color: var(--ui-text);
    font-size: 0.8125rem;
}

.agent-assistant-device-code strong {
    letter-spacing: 0;
}

.agent-assistant-error {
    margin: 0 0.875rem 0.875rem;
    padding: 0.5rem 0.7rem;
    border: 1px solid color-mix(in oklab, var(--ui-error) 30%, var(--ui-border) 70%);
    border-radius: var(--ui-radius);
    background: color-mix(in oklab, var(--ui-error) 8%, var(--ui-bg) 92%);
    color: var(--ui-error);
    font-size: 0.8125rem;
    line-height: 1.45;
}

.agent-assistant-image-preview {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    background: color-mix(in oklab, var(--ui-bg-inverted) 78%, transparent);
    -webkit-app-region: no-drag;
}

.agent-assistant-image-preview-backdrop {
    position: absolute;
    inset: 0;
    z-index: 0;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: zoom-out;
}

.agent-assistant-image-preview-content {
    position: relative;
    z-index: 1;
    display: flex;
    max-width: min(92vw, 72rem);
    max-height: 92vh;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
}

.agent-assistant-image-preview-image {
    display: block;
    max-width: min(92vw, 72rem);
    max-height: 86vh;
    border: 1px solid color-mix(in oklab, var(--ui-border) 72%, transparent);
    border-radius: var(--ui-radius);
    background: var(--ui-bg);
    box-shadow: var(--app-pdf-popover-shadow);
    object-fit: contain;
    user-select: none;
}

.agent-assistant-image-preview-caption {
    max-width: min(92vw, 72rem);
    overflow: hidden;
    color: color-mix(in oklab, var(--ui-bg) 82%, transparent);
    font-size: 0.8125rem;
    line-height: 1.4;
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.agent-assistant-image-preview-close {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 2;
}

.agent-assistant-image-preview-nav {
    position: absolute;
    top: 50%;
    z-index: 2;
    transform: translateY(-50%);
}

.agent-assistant-image-preview-nav.is-previous {
    left: 1rem;
}

.agent-assistant-image-preview-nav.is-next {
    right: 1rem;
}

@keyframes agent-assistant-spin {
    to {
        transform: rotate(360deg);
    }
}

@media (width <= 50rem) {
    .agent-assistant-panel {
        position: absolute;
        inset: var(--app-tabbar-height) 0 0 auto;
        z-index: 30;
        width: min(100vw, 24rem);
        flex: none;
        max-width: none;
        box-shadow: var(--app-pdf-context-menu-panel-shadow);
    }

    .agent-assistant-resizer {
        display: none;
    }
}
</style>
