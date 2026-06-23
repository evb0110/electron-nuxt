<template>
    <aside
        ref="panelRef"
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
                        @click="handleResetChat"
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
                <h2>{{ installTitle }}</h2>
                <p>{{ installDescription }}</p>
                <UButton
                    v-if="!isClaudeProvider"
                    :label="installButtonLabel"
                    icon="i-ph-download-simple"
                    color="primary"
                    :loading="isInstalling"
                    :disabled="isInstalling"
                    @click="handleInstallCodex"
                />
                <UButton
                    v-else
                    :label="t('assistant.refresh')"
                    icon="i-ph-arrows-clockwise"
                    color="primary"
                    @click="handleRefreshState"
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
                    @click="handleInstallCodex"
                />
            </section>

            <section
                v-else-if="panelView === 'sign-in'"
                class="agent-assistant-placeholder"
            >
                <span class="agent-assistant-glyph">
                    <UIcon name="i-ph-chat-circle-dots" class="agent-assistant-glyph-icon" />
                </span>
                <h2>{{ signInTitle }}</h2>
                <p>{{ signInDescription }}</p>
                <div
                    v-if="isClaudeProvider"
                    class="agent-assistant-placeholder-actions"
                >
                    <UButton
                        :label="t('assistant.refresh')"
                        icon="i-ph-arrows-clockwise"
                        color="primary"
                        @click="handleRefreshState"
                    />
                </div>
                <div
                    v-else
                    class="agent-assistant-placeholder-actions"
                >
                    <UButton
                        :label="t('assistant.signInChatGpt')"
                        icon="i-ph-arrow-square-out"
                        color="primary"
                        :loading="isLoggingIn && loginMode === 'chatgpt'"
                        :disabled="isLoggingIn || status.authState === 'login-pending'"
                        @click="handleStartLogin('chatgpt')"
                    />
                    <UButton
                        v-if="status.authState === 'login-pending'"
                        :label="t('assistant.cancelLogin')"
                        icon="i-ph-x"
                        color="neutral"
                        variant="outline"
                        :disabled="isLoggingIn"
                        @click="handleCancelLogin"
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
                            v-for="{ message, blocks } in renderedMessages"
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
                            <div
                                v-if="message.text || message.pending"
                                class="agent-assistant-message-row"
                            >
                                <div class="agent-assistant-message-bubble">
                                    <template v-if="message.text">
                                        <template
                                            v-for="(block, blockIndex) in blocks"
                                            :key="`${message.id}-${blockIndex}`"
                                        >
                                            <pre
                                                v-if="block.kind === 'code'"
                                                class="agent-assistant-message-code-block"
                                            ><code>{{ block.code }}</code></pre>
                                            <p
                                                v-else-if="block.kind === 'heading'"
                                                class="agent-assistant-message-heading"
                                                :data-level="block.level"
                                            >
                                                <template
                                                    v-for="(segment, segmentIndex) in block.segments"
                                                    :key="`${message.id}-${blockIndex}-${segmentIndex}`"
                                                >
                                                    <code
                                                        v-if="segment.kind === 'code'"
                                                        class="agent-assistant-message-inline-code"
                                                    >{{ segment.text }}</code>
                                                    <strong
                                                        v-else-if="segment.kind === 'strong'"
                                                        class="agent-assistant-message-strong"
                                                    >{{ segment.text }}</strong>
                                                    <em
                                                        v-else-if="segment.kind === 'emphasis'"
                                                        class="agent-assistant-message-emphasis"
                                                    >{{ segment.text }}</em>
                                                    <a
                                                        v-else-if="segment.kind === 'link'"
                                                        class="agent-assistant-message-link"
                                                        :href="segment.href"
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                    >{{ segment.text }}</a>
                                                    <span v-else>{{ segment.text }}</span>
                                                </template>
                                            </p>
                                            <template v-else-if="block.kind === 'list'">
                                                <ol
                                                    v-if="block.ordered"
                                                    class="agent-assistant-message-list is-ordered"
                                                >
                                                    <li
                                                        v-for="(item, itemIndex) in block.items"
                                                        :key="`${message.id}-${blockIndex}-${itemIndex}`"
                                                    >
                                                        <template
                                                            v-for="(segment, segmentIndex) in item"
                                                            :key="`${message.id}-${blockIndex}-${itemIndex}-${segmentIndex}`"
                                                        >
                                                            <code
                                                                v-if="segment.kind === 'code'"
                                                                class="agent-assistant-message-inline-code"
                                                            >{{ segment.text }}</code>
                                                            <strong
                                                                v-else-if="segment.kind === 'strong'"
                                                                class="agent-assistant-message-strong"
                                                            >{{ segment.text }}</strong>
                                                            <em
                                                                v-else-if="segment.kind === 'emphasis'"
                                                                class="agent-assistant-message-emphasis"
                                                            >{{ segment.text }}</em>
                                                            <a
                                                                v-else-if="segment.kind === 'link'"
                                                                class="agent-assistant-message-link"
                                                                :href="segment.href"
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                            >{{ segment.text }}</a>
                                                            <span v-else>{{ segment.text }}</span>
                                                        </template>
                                                    </li>
                                                </ol>
                                                <ul
                                                    v-else
                                                    class="agent-assistant-message-list"
                                                >
                                                    <li
                                                        v-for="(item, itemIndex) in block.items"
                                                        :key="`${message.id}-${blockIndex}-${itemIndex}`"
                                                    >
                                                        <template
                                                            v-for="(segment, segmentIndex) in item"
                                                            :key="`${message.id}-${blockIndex}-${itemIndex}-${segmentIndex}`"
                                                        >
                                                            <code
                                                                v-if="segment.kind === 'code'"
                                                                class="agent-assistant-message-inline-code"
                                                            >{{ segment.text }}</code>
                                                            <strong
                                                                v-else-if="segment.kind === 'strong'"
                                                                class="agent-assistant-message-strong"
                                                            >{{ segment.text }}</strong>
                                                            <em
                                                                v-else-if="segment.kind === 'emphasis'"
                                                                class="agent-assistant-message-emphasis"
                                                            >{{ segment.text }}</em>
                                                            <a
                                                                v-else-if="segment.kind === 'link'"
                                                                class="agent-assistant-message-link"
                                                                :href="segment.href"
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                            >{{ segment.text }}</a>
                                                            <span v-else>{{ segment.text }}</span>
                                                        </template>
                                                    </li>
                                                </ul>
                                            </template>
                                            <blockquote
                                                v-else-if="block.kind === 'blockquote'"
                                                class="agent-assistant-message-blockquote"
                                            >
                                                <template
                                                    v-for="(segment, segmentIndex) in block.segments"
                                                    :key="`${message.id}-${blockIndex}-${segmentIndex}`"
                                                >
                                                    <code
                                                        v-if="segment.kind === 'code'"
                                                        class="agent-assistant-message-inline-code"
                                                    >{{ segment.text }}</code>
                                                    <strong
                                                        v-else-if="segment.kind === 'strong'"
                                                        class="agent-assistant-message-strong"
                                                    >{{ segment.text }}</strong>
                                                    <em
                                                        v-else-if="segment.kind === 'emphasis'"
                                                        class="agent-assistant-message-emphasis"
                                                    >{{ segment.text }}</em>
                                                    <a
                                                        v-else-if="segment.kind === 'link'"
                                                        class="agent-assistant-message-link"
                                                        :href="segment.href"
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                    >{{ segment.text }}</a>
                                                    <span v-else>{{ segment.text }}</span>
                                                </template>
                                            </blockquote>
                                            <hr
                                                v-else-if="block.kind === 'rule'"
                                                class="agent-assistant-message-rule"
                                            >
                                            <p
                                                v-else
                                                class="agent-assistant-message-text"
                                            >
                                                <template
                                                    v-for="(segment, segmentIndex) in block.segments"
                                                    :key="`${message.id}-${blockIndex}-${segmentIndex}`"
                                                >
                                                    <code
                                                        v-if="segment.kind === 'code'"
                                                        class="agent-assistant-message-inline-code"
                                                    >{{ segment.text }}</code>
                                                    <strong
                                                        v-else-if="segment.kind === 'strong'"
                                                        class="agent-assistant-message-strong"
                                                    >{{ segment.text }}</strong>
                                                    <em
                                                        v-else-if="segment.kind === 'emphasis'"
                                                        class="agent-assistant-message-emphasis"
                                                    >{{ segment.text }}</em>
                                                    <a
                                                        v-else-if="segment.kind === 'link'"
                                                        class="agent-assistant-message-link"
                                                        :href="segment.href"
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                    >{{ segment.text }}</a>
                                                    <span v-else>{{ segment.text }}</span>
                                                </template>
                                            </p>
                                        </template>
                                    </template>
                                    <p
                                        v-else
                                        class="agent-assistant-message-text"
                                    >
                                        {{ t('assistant.working') }}
                                    </p>
                                </div>
                                <AppTooltip
                                    v-if="message.text"
                                    :text="copyMessageTooltip(message.id)"
                                    :delay-duration="300"
                                >
                                    <UButton
                                        class="agent-assistant-message-copy"
                                        :aria-label="copyMessageTooltip(message.id)"
                                        :icon="copyMessageIcon(message.id)"
                                        color="neutral"
                                        variant="ghost"
                                        size="xs"
                                        type="button"
                                        @click="handleCopyMessageText(message.id, message.text)"
                                    />
                                </AppTooltip>
                            </div>
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
                        @submit.prevent="handleSendMessage"
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
                                @keydown.enter.exact.prevent="handleSendMessage"
                                @paste="handleComposerPaste"
                            />
                            <div class="agent-assistant-composer-actions">
                                <div class="agent-assistant-composer-switchers">
                                    <AssistantModelSwitcher
                                        v-if="hasLoadedState"
                                        :providers="status.providers"
                                        :selected-provider="selectedProvider"
                                        :selected-model="selectedModel"
                                        :is-switching="isSwitchingAssistant"
                                        :disabled="assistantSelectionLocked"
                                        side="top"
                                        @select-provider="updateProvider"
                                        @select-model="updateModel"
                                    />
                                    <AssistantEffortSwitcher
                                        v-if="hasLoadedState && status.availableEfforts.length > 0"
                                        :efforts="status.availableEfforts"
                                        :selected-effort="selectedEffort"
                                        :disabled="assistantSelectionLocked"
                                        side="top"
                                        @select-effort="updateEffort"
                                    />
                                </div>
                                <UButton
                                    v-if="isSending"
                                    :aria-label="t('assistant.stop')"
                                    icon="i-ph-stop-circle"
                                    color="neutral"
                                    variant="outline"
                                    size="sm"
                                    @click="handleInterrupt"
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

            <div
                v-if="hasLoadedState && !hasComposer && panelView !== 'unsupported'"
                class="agent-assistant-setup-footer"
            >
                <AssistantModelSwitcher
                    :providers="status.providers"
                    :selected-provider="selectedProvider"
                    :selected-model="selectedModel"
                    :is-switching="isSwitchingAssistant"
                    :disabled="assistantSelectionLocked"
                    side="top"
                    @select-provider="updateProvider"
                    @select-model="updateModel"
                />
                <AssistantEffortSwitcher
                    v-if="status.availableEfforts.length > 0"
                    :efforts="status.availableEfforts"
                    :selected-effort="selectedEffort"
                    :disabled="assistantSelectionLocked"
                    side="top"
                    @select-effort="updateEffort"
                />
            </div>

            <p
                v-if="status.error && !hasMessages"
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
    IAgentAssistantChatMessage,
    IAgentAssistantEvent,
    IAgentAssistantImageAttachment,
    IAgentAssistantProviderStatus,
    IAgentAssistantState,
    IAgentAssistantStatus,
    TAgentAssistantEffort,
    TAgentAssistantLoginMode,
    TAgentAssistantMessageRole,
    TAgentAssistantProviderId,
} from '@contracts/agent';
import {
    ASSISTANT_DEFAULT_EFFORT,
    CLAUDE_ASSISTANT_EFFORTS,
    CLAUDE_ASSISTANT_DEFAULT_MODEL,
    CLAUDE_ASSISTANT_MODELS,
    CODEX_ASSISTANT_EFFORTS,
    CODEX_ASSISTANT_DEFAULT_MODEL,
    CODEX_ASSISTANT_FALLBACK_MODELS,
} from '@contracts/agentModels';
import AssistantEffortSwitcher from '@app/modules/agent-panel/components/AssistantEffortSwitcher.vue';
import AssistantModelSwitcher from '@app/modules/agent-panel/components/AssistantModelSwitcher.vue';
import { isAssistantSelectionLocked } from '@app/modules/agent-panel/utils/isAssistantSelectionLocked';
import { formatAssistantMessage } from '@app/modules/agent-panel/utils/formatAssistantMessage';
import { getAgentAssistantPanelView } from '@app/modules/workspace-shell/public';
import { guardAsync } from '@app/utils/asyncGuard';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
import { getPlatformAPI } from '@app/utils/platform';
import {
    defaultDocument,
    defaultWindow,
    useClipboard,
    useEventListener,
    useTimeoutFn,
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
const { reportRuntimeError } = useRuntimeErrorReports();
const { copy: copyClipboardText } = useClipboard();
const ASSISTANT_MAX_IMAGE_ATTACHMENTS = 8;
const ASSISTANT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ASSISTANT_IMAGE_SIZE_LIMIT_LABEL = `${Math.round(ASSISTANT_MAX_IMAGE_BYTES / (1024 * 1024))} MB`;
const ASSISTANT_AUTO_REFRESH_MIN_INTERVAL_MS = 2500;
const ASSISTANT_SCROLL_STICKY_THRESHOLD_PX = 96;
const EMPTY_ASSISTANT_MESSAGE_BLOCKS: ReturnType<typeof formatAssistantMessage> = [];
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
const copiedMessageId = ref<string | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const messagesRef = ref<HTMLElement | null>(null);
const state = ref<IAgentAssistantState | null>(null);
const selectedProvider = ref<TAgentAssistantProviderId>('codex');
const selectedModel = ref(CODEX_ASSISTANT_DEFAULT_MODEL);
const hasLocalModelSelection = ref(false);
const selectedEffort = ref<TAgentAssistantEffort>('high');
const hasLocalEffortSelection = ref(false);
const isSwitchingAssistant = ref(false);
let sendGeneration = 0;
let stateGeneration = 0;
let assistantSwitchGeneration = 0;
let lastRefreshStartedAt = 0;

const {
    start: startCopiedMessageReset,
    stop: stopCopiedMessageReset,
} = useTimeoutFn(() => {
    copiedMessageId.value = null;
}, 1800, { immediate: false });

interface IExpandedImageItem {
    src: string;
    name: string;
}

interface IExpandedImagePreview {
    images: IExpandedImageItem[];
    index: number;
}

type TAssistantActionErrorTarget = 'status' | 'composer' | 'none';

interface IAssistantActionErrorOptions {
    title: string;
    target?: TAssistantActionErrorTarget;
    log?: boolean;
}

interface IAssistantMarkdownCacheEntry {
    text: string;
    blocks: ReturnType<typeof formatAssistantMessage>;
}

const assistantMarkdownCache = new Map<string, IAssistantMarkdownCacheEntry>();

const emptyState = computed<IAgentAssistantState>(() => ({
    scope: chatScope ? cloneAssistantScope(chatScope) : null,
    status: {
        supported: true,
        platform: '',
        provider: selectedProvider.value,
        providerLabel: selectedProvider.value === 'claude' ? 'Claude' : 'Codex',
        providers: [
            {
                id: 'codex',
                label: 'Codex',
                installState: 'missing',
                authState: 'unknown',
                runtimeState: 'stopped',
                models: [...CODEX_ASSISTANT_FALLBACK_MODELS],
                defaultModel: CODEX_ASSISTANT_DEFAULT_MODEL,
                activeModel: CODEX_ASSISTANT_DEFAULT_MODEL,
                modelSwitchMode: 'in-session',
                availableEfforts: [...CODEX_ASSISTANT_EFFORTS],
                defaultEffort: ASSISTANT_DEFAULT_EFFORT,
                activeEffort: selectedProvider.value === 'codex' ? selectedEffort.value : ASSISTANT_DEFAULT_EFFORT,
                path: null,
                version: null,
                minimumVersion: '0.133.0',
                versionSupported: false,
                installUrl: '',
                account: null,
            },
            {
                id: 'claude',
                label: 'Claude',
                installState: 'missing',
                authState: 'unknown',
                runtimeState: 'stopped',
                models: [...CLAUDE_ASSISTANT_MODELS],
                defaultModel: CLAUDE_ASSISTANT_DEFAULT_MODEL,
                activeModel: CLAUDE_ASSISTANT_DEFAULT_MODEL,
                modelSwitchMode: 'in-session',
                availableEfforts: [...CLAUDE_ASSISTANT_EFFORTS],
                defaultEffort: ASSISTANT_DEFAULT_EFFORT,
                activeEffort: selectedProvider.value === 'claude' ? selectedEffort.value : ASSISTANT_DEFAULT_EFFORT,
                path: null,
                version: null,
                minimumVersion: null,
                versionSupported: false,
                installUrl: '',
                account: null,
            },
        ],
        model: selectedModel.value,
        modelLabel: selectedModel.value,
        models: selectedProvider.value === 'claude'
            ? [...CLAUDE_ASSISTANT_MODELS]
            : [...CODEX_ASSISTANT_FALLBACK_MODELS],
        modelSwitchMode: 'in-session',
        effort: selectedEffort.value,
        availableEfforts: selectedProvider.value === 'claude'
            ? [...CLAUDE_ASSISTANT_EFFORTS]
            : [...CODEX_ASSISTANT_EFFORTS],
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
} satisfies IAgentAssistantState));
const status = computed(() => (state.value ?? emptyState.value).status);
const messages = computed(() => (state.value ?? emptyState.value).messages);
const renderedMessages = computed(() => {
    const activeMessageIds = new Set<string>();
    const rendered = messages.value.map((message) => {
        activeMessageIds.add(message.id);
        return {
            message,
            blocks: getCachedAssistantMessageBlocks(message),
        };
    });
    pruneAssistantMarkdownCache(activeMessageIds);
    return rendered;
});
const isClaudeProvider = computed(() => selectedProvider.value === 'claude');
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
const installTitle = computed(() => isClaudeProvider.value
    ? t('assistant.installClaudeTitle')
    : t('assistant.installTitle'));
const installDescription = computed(() => isClaudeProvider.value
    ? t('assistant.installClaudeDescription')
    : t('assistant.installDescription'));
const signInTitle = computed(() => isClaudeProvider.value
    ? t('assistant.signInClaudeTitle')
    : t('assistant.signInTitle'));
const signInDescription = computed(() => isClaudeProvider.value
    ? t('assistant.signInClaudeDescription')
    : t('assistant.signInDescription'));
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
const assistantSelectionLocked = computed(() => isAssistantSelectionLocked({
    activeTurnId: status.value.activeTurnId,
    isSending: isSending.value,
    runtimeState: status.value.runtimeState,
    turnPhase: status.value.turn.phase,
}));
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

function getCachedAssistantMessageBlocks(message: IAgentAssistantChatMessage) {
    if (message.text.length === 0) {
        return EMPTY_ASSISTANT_MESSAGE_BLOCKS;
    }

    const cached = assistantMarkdownCache.get(message.id);
    if (cached?.text === message.text) {
        return cached.blocks;
    }

    const blocks = formatAssistantMessage(message.text);
    assistantMarkdownCache.set(message.id, {
        text: message.text,
        blocks,
    });
    return blocks;
}

function pruneAssistantMarkdownCache(activeMessageIds: Set<string>) {
    assistantMarkdownCache.forEach((_entry, messageId) => {
        if (!activeMessageIds.has(messageId)) {
            assistantMarkdownCache.delete(messageId);
        }
    });
}

function getAssistantActionErrorMessage(error: unknown) {
    const message = getErrorMessage(error).trim();
    return message.length > 0 && message !== 'undefined' && message !== 'null'
        ? message
        : t('errors.runtime.description');
}

function applyAssistantStatusError(message: string) {
    const baseState = state.value ?? emptyState.value;
    state.value = {
        ...baseState,
        status: {
            ...baseState.status,
            runtimeState: baseState.status.runtimeState === 'starting' ? 'error' : baseState.status.runtimeState,
            error: message,
        },
    };
    hasLoadedState.value = true;
}

function reportAssistantActionError(error: unknown, options: IAssistantActionErrorOptions) {
    if (options.log !== false) {
        BrowserLogger.error('assistant', options.title, error);
    }
    reportRuntimeError({
        title: options.title,
        source: 'assistant',
        error,
    });
}

function handleAssistantActionError(error: unknown, options: IAssistantActionErrorOptions) {
    const message = getAssistantActionErrorMessage(error);
    const target = options.target ?? 'status';
    reportAssistantActionError(error, options);
    if (target === 'status') {
        applyAssistantStatusError(message);
    } else if (target === 'composer') {
        composerError.value = message;
    }
    return message;
}

function runAssistantUiAction(
    task: () => Promise<unknown>,
    options: IAssistantActionErrorOptions,
) {
    void (async () => {
        try {
            await task();
        } catch (error) {
            handleAssistantActionError(error, options);
        }
    })();
}

function isCopyShortcut(event: KeyboardEvent) {
    return (event.metaKey || event.ctrlKey)
        && !event.altKey
        && event.key.toLowerCase() === 'c';
}

function isEditableCopyTarget(target: EventTarget | null) {
    if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) {
        return false;
    }
    return Boolean(
        target.isContentEditable === true
        || Boolean(target.closest('[contenteditable="true"], [contenteditable=""]'))
        || Boolean(target.closest('input, textarea, select')),
    );
}

function rangeIntersectsPanel(range: Range, panel: HTMLElement) {
    try {
        return range.intersectsNode(panel);
    } catch {
        return false;
    }
}

function selectionNodeIsInPanel(node: Node | null, panel: HTMLElement) {
    return Boolean(node && (node === panel || panel.contains(node)));
}

function getAssistantSelectionText() {
    const panel = panelRef.value;
    const selection = defaultDocument?.getSelection();
    if (!panel || !selection || selection.isCollapsed || selection.rangeCount === 0) {
        return '';
    }

    const isSelectionInPanel = selectionNodeIsInPanel(selection.anchorNode, panel)
        || selectionNodeIsInPanel(selection.focusNode, panel)
        || Array.from({ length: selection.rangeCount }).some((_, index) => (
            rangeIntersectsPanel(selection.getRangeAt(index), panel)
        ));
    if (!isSelectionInPanel) {
        return '';
    }

    const text = selection.toString();
    return text.trim().length > 0 ? text : '';
}

async function copyText(text: string, logMessage: string) {
    try {
        await copyClipboardText(text);
        return true;
    } catch (error) {
        BrowserLogger.warn('assistant', logMessage, error);
        return false;
    }
}

function copyMessageTooltip(messageId: string) {
    return copiedMessageId.value === messageId
        ? t('assistant.copyMessageCopied')
        : t('assistant.copyMessage');
}

function copyMessageIcon(messageId: string) {
    return copiedMessageId.value === messageId
        ? 'i-ph-check'
        : 'i-ph-copy';
}

async function copyMessageText(messageId: string, text: string) {
    if (text.trim().length === 0) {
        return;
    }

    const copied = await copyText(text, 'Failed to copy assistant message text');
    if (!copied) {
        return;
    }

    stopCopiedMessageReset();
    copiedMessageId.value = messageId;
    startCopiedMessageReset();
}

function handleCopyMessageText(messageId: string, text: string) {
    void copyMessageText(messageId, text);
}

function handleAssistantCopyShortcut(event: KeyboardEvent) {
    if (!isCopyShortcut(event) || isEditableCopyTarget(event.target)) {
        return;
    }

    const text = getAssistantSelectionText();
    if (!text) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    void copyText(text, 'Failed to copy selected assistant text');
}

function cloneAssistantScope(scope: IAgentAssistantChatScope): IAgentAssistantChatScope {
    return {
        kind: scope.kind,
        key: scope.key,
        title: scope.title,
        ...(scope.tabId == null ? {} : { tabId: scope.tabId }),
        ...(scope.documentRef == null ? {} : { documentRef: scope.documentRef }),
    };
}

function modelForSelection(
    providerStatus: IAgentAssistantProviderStatus,
    model: string,
) {
    return providerStatus.models.find(candidate => candidate.id === model)
        ?? providerStatus.models.find(candidate => candidate.id === providerStatus.defaultModel)
        ?? providerStatus.models[0]
        ?? null;
}

function createSelectedAssistantStatus(
    baseStatus: IAgentAssistantStatus,
    providerStatus: IAgentAssistantProviderStatus,
    model: string,
    effort: TAgentAssistantEffort,
) {
    const selectedModelOption = modelForSelection(providerStatus, model);
    const selectedModel = selectedModelOption?.id ?? model;
    const selectedModelLabel = selectedModelOption?.label ?? selectedModel;
    const selectedEffortValue = providerStatus.availableEfforts.includes(effort)
        ? effort
        : providerStatus.defaultEffort;
    const providers = baseStatus.providers.map(candidate => (candidate.id === providerStatus.id
        ? {
            ...candidate,
            activeModel: selectedModel,
            activeEffort: selectedEffortValue,
        }
        : candidate));
    const codexProvider = providerStatus.id === 'codex'
        ? providerStatus
        : providers.find(candidate => candidate.id === 'codex');
    const preserveTurn = baseStatus.provider === providerStatus.id;
    const {
        error: _baseError,
        ...baseStatusWithoutError
    } = baseStatus;

    return {
        ...baseStatusWithoutError,
        provider: providerStatus.id,
        providerLabel: providerStatus.label,
        providers,
        model: selectedModel,
        modelLabel: selectedModelLabel,
        models: providerStatus.models,
        modelSwitchMode: providerStatus.modelSwitchMode,
        effort: selectedEffortValue,
        availableEfforts: providerStatus.availableEfforts,
        installState: providerStatus.installState,
        codexInstalled: codexProvider?.installState === 'installed',
        codexPath: codexProvider?.path ?? null,
        codexVersion: codexProvider?.version ?? null,
        minimumCodexVersion: codexProvider?.minimumVersion ?? baseStatus.minimumCodexVersion,
        codexVersionSupported: codexProvider?.versionSupported ?? baseStatus.codexVersionSupported,
        installUrl: providerStatus.installUrl,
        authState: providerStatus.authState,
        account: providerStatus.account,
        runtimeState: providerStatus.runtimeState,
        turn: preserveTurn
            ? baseStatus.turn
            : {
                id: null,
                phase: 'idle',
            },
        threadId: preserveTurn ? baseStatus.threadId : null,
        activeTurnId: preserveTurn ? baseStatus.activeTurnId : null,
        ...(providerStatus.error ? { error: providerStatus.error } : {}),
    } satisfies IAgentAssistantStatus;
}

function createOptimisticAssistantState(
    provider: TAgentAssistantProviderId,
    model: string,
    effort: TAgentAssistantEffort,
    keepMessages: boolean,
): IAgentAssistantState | null {
    const baseState = state.value ?? emptyState.value;
    const providerStatus = baseState.status.providers.find(candidate => candidate.id === provider);
    if (!providerStatus) {
        return null;
    }

    const shouldKeepMessages = keepMessages
        && baseState.status.provider === provider
        && getStateScopeKey(baseState) === (chatScope?.key ?? null);
    return {
        scope: chatScope ? cloneAssistantScope(chatScope) : null,
        status: createSelectedAssistantStatus(baseState.status, providerStatus, model, effort),
        messages: shouldKeepMessages ? baseState.messages : [],
    };
}

function applyOptimisticSelection(
    provider: TAgentAssistantProviderId,
    model: string,
    effort: TAgentAssistantEffort,
    keepMessages: boolean,
) {
    const optimisticState = createOptimisticAssistantState(provider, model, effort, keepMessages);
    if (!optimisticState) {
        return;
    }

    state.value = optimisticState;
    hasLoadedState.value = true;
    isSending.value = optimisticState.status.runtimeState === 'busy';
}

function createAssistantStateRequest() {
    return {
        scope: chatScope ? cloneAssistantScope(chatScope) : null,
        provider: selectedProvider.value,
        model: selectedModel.value,
        effort: selectedEffort.value,
    };
}

function getStateScopeKey(nextState: IAgentAssistantState) {
    return nextState.scope?.key ?? null;
}

function isCurrentScopeState(nextState: IAgentAssistantState) {
    return nextState.status.provider === selectedProvider.value
        && getStateScopeKey(nextState) === (chatScope?.key ?? null);
}

function isAssistantMessagesNearBottom() {
    const el = messagesRef.value;
    if (!el) {
        return true;
    }

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distanceFromBottom <= ASSISTANT_SCROLL_STICKY_THRESHOLD_PX;
}

function scrollAssistantMessagesToBottom() {
    const el = messagesRef.value;
    if (el) {
        el.scrollTop = el.scrollHeight;
    }
}

function applyState(nextState: IAgentAssistantState) {
    if (!isCurrentScopeState(nextState)) {
        return;
    }
    const shouldScrollToBottom = isAssistantMessagesNearBottom();
    const providerStatus = nextState.status.providers.find(provider => provider.id === nextState.status.provider);
    const needsModelOverride = hasLocalModelSelection.value && nextState.status.model !== selectedModel.value;
    const needsEffortOverride = hasLocalEffortSelection.value && nextState.status.effort !== selectedEffort.value;
    const adjustedState = providerStatus && (needsModelOverride || needsEffortOverride)
        ? {
            ...nextState,
            status: createSelectedAssistantStatus(
                nextState.status,
                providerStatus,
                needsModelOverride ? selectedModel.value : nextState.status.model,
                needsEffortOverride ? selectedEffort.value : nextState.status.effort,
            ),
        }
        : nextState;
    selectedProvider.value = adjustedState.status.provider;
    selectedModel.value = adjustedState.status.model;
    selectedEffort.value = adjustedState.status.effort;
    state.value = adjustedState;
    hasLoadedState.value = true;
    isSending.value = adjustedState.status.runtimeState === 'busy';
    if (shouldScrollToBottom) {
        void nextTick(scrollAssistantMessagesToBottom);
    }
}

function handleAssistantEvent(event: IAgentAssistantEvent) {
    if (event.state) {
        applyState(event.state);
    }
    if (event.type === 'message-delta' && event.messageId && event.delta && state.value) {
        const messageIndex = state.value.messages.findIndex(message => message.id === event.messageId);
        if (messageIndex >= 0) {
            const messages = [...state.value.messages];
            const message = messages[messageIndex];
            if (!message) {
                return;
            }
            messages[messageIndex] = {
                ...message,
                text: `${message.text}${event.delta}`,
                pending: true,
            };
            state.value = {
                ...state.value,
                messages,
            };
            void nextTick(scrollAssistantMessagesToBottom);
        }
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

function providerDefaultModel(provider: TAgentAssistantProviderId) {
    const providerStatus = status.value.providers.find(candidate => candidate.id === provider);
    return providerStatus?.activeModel
        ?? providerStatus?.defaultModel
        ?? 'default';
}

function providerDefaultEffort(provider: TAgentAssistantProviderId): TAgentAssistantEffort {
    const providerStatus = status.value.providers.find(candidate => candidate.id === provider);
    return providerStatus?.activeEffort
        ?? providerStatus?.defaultEffort
        ?? 'high';
}

function normalizeEffortValue(value: unknown): TAgentAssistantEffort | null {
    const id = typeof value === 'object' && value && 'value' in value
        ? (value as { value?: unknown }).value
        : value;
    return id === 'low' || id === 'medium' || id === 'high' || id === 'xhigh' || id === 'max'
        ? id
        : null;
}

function normalizeProviderValue(value: unknown): TAgentAssistantProviderId {
    const id = typeof value === 'object' && value && 'value' in value
        ? (value as { value?: unknown }).value
        : value;
    return id === 'claude' ? 'claude' : 'codex';
}

function normalizeModelValue(value: unknown) {
    const id = typeof value === 'object' && value && 'value' in value
        ? (value as { value?: unknown }).value
        : value;
    return typeof id === 'string' ? id : null;
}

function updateProvider(value: unknown) {
    if (assistantSelectionLocked.value) {
        return;
    }
    const nextProvider = normalizeProviderValue(value);
    if (nextProvider === selectedProvider.value) {
        return;
    }
    const nextSwitchGeneration = ++assistantSwitchGeneration;
    selectedProvider.value = nextProvider;
    selectedModel.value = providerDefaultModel(nextProvider);
    hasLocalModelSelection.value = false;
    selectedEffort.value = providerDefaultEffort(nextProvider);
    hasLocalEffortSelection.value = false;
    sendGeneration += 1;
    applyOptimisticSelection(nextProvider, selectedModel.value, selectedEffort.value, false);
    draft.value = '';
    composerImages.value = [];
    composerError.value = '';
    isSending.value = false;
    isSwitchingAssistant.value = true;
    guardAsync(refreshState().finally(() => {
        if (nextSwitchGeneration === assistantSwitchGeneration) {
            isSwitchingAssistant.value = false;
        }
    }), {
        scope: 'assistant',
        message: 'Failed to switch assistant provider',
        onError: error => handleAssistantActionError(error, {
            title: 'Failed to switch assistant provider',
            log: false,
        }),
    });
}

function updateModel(value: unknown) {
    if (assistantSelectionLocked.value) {
        return;
    }
    const nextModel = normalizeModelValue(value);
    if (!nextModel || nextModel === selectedModel.value) {
        return;
    }
    selectedModel.value = nextModel;
    hasLocalModelSelection.value = true;
    applyOptimisticSelection(selectedProvider.value, nextModel, selectedEffort.value, true);
}

function updateEffort(value: unknown) {
    if (assistantSelectionLocked.value) {
        return;
    }
    const nextEffort = normalizeEffortValue(value);
    if (!nextEffort || nextEffort === selectedEffort.value) {
        return;
    }
    selectedEffort.value = nextEffort;
    hasLocalEffortSelection.value = true;
    applyOptimisticSelection(selectedProvider.value, selectedModel.value, nextEffort, true);
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

function handleInstallCodex() {
    runAssistantUiAction(installCodex, { title: 'Failed to install assistant Codex' });
}

function handleStartLogin(mode: TAgentAssistantLoginMode) {
    runAssistantUiAction(() => startLogin(mode), { title: 'Failed to start assistant login' });
}

function handleCancelLogin() {
    runAssistantUiAction(cancelLogin, { title: 'Failed to cancel assistant login' });
}

function handleRefreshState() {
    runAssistantUiAction(refreshState, { title: 'Failed to refresh assistant state' });
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
            provider: selectedProvider.value,
            model: selectedModel.value,
            effort: selectedEffort.value,
            ...(attachments.length > 0 ? { attachments } : {}),
        });
        if (generation !== sendGeneration) {
            return;
        }
        applyState(result.state);
    } catch (error) {
        if (generation === sendGeneration) {
            draft.value = text;
            composerImages.value = attachments;
            handleAssistantActionError(error, {
                title: 'Failed to send assistant message',
                target: 'composer',
            });
        } else {
            reportAssistantActionError(error, { title: 'Stale assistant message request failed' });
        }
    } finally {
        if (generation === sendGeneration) {
            isSending.value = status.value.runtimeState === 'busy';
        }
    }
}

function handleSendMessage() {
    void sendMessage();
}

async function interrupt() {
    if (!chatScope) {
        return;
    }
    sendGeneration += 1;
    applyState(await getPlatformAPI().agent.interruptAssistant(createAssistantStateRequest()));
}

function handleInterrupt() {
    runAssistantUiAction(interrupt, { title: 'Failed to interrupt assistant turn' });
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

function handleResetChat() {
    runAssistantUiAction(resetChat, { title: 'Failed to reset assistant chat' });
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
useEventListener(defaultWindow, 'keydown', handleAssistantCopyShortcut, { capture: true });
useEventListener(defaultWindow, 'keydown', handleExpandedImageKeydown);

onUnmounted(() => {
    stopCopiedMessageReset();
    unsubscribe?.();
    unsubscribe = null;
});
</script>

<style scoped>
.agent-assistant-panel {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 0 1 min(var(--assistant-panel-width, var(--app-assistant-panel-default-width)), var(--app-assistant-panel-max-viewport-width));
    width: min(var(--assistant-panel-width, var(--app-assistant-panel-default-width)), var(--app-assistant-panel-max-viewport-width));
    max-width: 100%;
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
.agent-assistant-message-text,
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

.agent-assistant-message-row {
    display: flex;
    max-width: 100%;
    align-items: flex-start;
    gap: 0.25rem;
}

.agent-assistant-message.is-user .agent-assistant-message-row {
    flex-direction: row-reverse;
}

.agent-assistant-message-bubble {
    display: flex;
    min-width: 0;
    max-width: 100%;
    flex-direction: column;
    gap: 0.45rem;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--ui-border);
    border-radius: 0.9rem;
    background: var(--ui-bg);
    color: var(--ui-text);
    font-size: 0.8125rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
    user-select: text;
}

.agent-assistant-message.is-assistant .agent-assistant-message-bubble {
    border-bottom-left-radius: 0.3rem;
}

.agent-assistant-message.is-user .agent-assistant-message-bubble {
    border-color: transparent;
    border-bottom-right-radius: 0.3rem;
    background: var(--ui-primary);
    color: var(--ui-primary-fg);
}

.agent-assistant-message.is-system .agent-assistant-message-bubble {
    border-color: color-mix(in oklab, var(--ui-error) 30%, var(--ui-border) 70%);
    background: color-mix(in oklab, var(--ui-error) 8%, var(--ui-bg) 92%);
    color: var(--ui-error);
}

.agent-assistant-message.is-pending .agent-assistant-message-bubble {
    border-color: color-mix(in oklab, var(--ui-primary) 34%, var(--ui-border) 66%);
}

.agent-assistant-message-text {
    margin: 0;
    color: inherit;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

.agent-assistant-message-heading {
    margin: 0;
    color: inherit;
    font-size: 0.875rem;
    font-weight: var(--app-font-weight-semibold);
    line-height: 1.4;
    overflow-wrap: anywhere;
}

.agent-assistant-message-heading[data-level="1"],
.agent-assistant-message-heading[data-level="2"] {
    font-size: 0.95rem;
}

.agent-assistant-message-strong {
    color: inherit;
    font-weight: var(--app-font-weight-semibold);
}

.agent-assistant-message-emphasis {
    color: inherit;
    font-style: italic;
}

.agent-assistant-message-link {
    color: var(--ui-primary);
    text-decoration: underline;
    text-underline-offset: 0.14em;
    overflow-wrap: anywhere;
}

.agent-assistant-message-list {
    margin: 0;
    padding-inline-start: 1.1rem;
    color: inherit;
}

.agent-assistant-message-list li {
    padding-inline-start: 0.05rem;
}

.agent-assistant-message-list li + li {
    margin-top: 0.15rem;
}

.agent-assistant-message-blockquote {
    margin: 0;
    padding: 0.05rem 0 0.05rem 0.6rem;
    border-left: 2px solid color-mix(in oklab, var(--ui-text-dimmed) 45%, transparent);
    color: inherit;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

.agent-assistant-message-rule {
    width: 100%;
    margin: 0.05rem 0;
    border: 0;
    border-top: 1px solid var(--ui-border);
}

.agent-assistant-message-inline-code,
.agent-assistant-message-code-block {
    border: 1px solid color-mix(in oklab, var(--ui-border) 72%, transparent);
    border-radius: var(--app-radius-sm);
    background: var(--ui-bg-muted);
    color: var(--ui-text);
    font-family: var(--app-font-mono);
}

.agent-assistant-message-inline-code {
    padding: 0 0.25rem;
    font-size: 0.78em;
}

.agent-assistant-message-code-block {
    max-width: 100%;
    margin: 0;
    overflow: auto;
    padding: 0.5rem 0.6rem;
    font-size: 0.75rem;
    line-height: 1.45;
    white-space: pre;
}

.agent-assistant-message-code-block code {
    font: inherit;
}

.agent-assistant-message.is-user .agent-assistant-message-inline-code,
.agent-assistant-message.is-user .agent-assistant-message-code-block {
    border-color: color-mix(in oklab, var(--ui-primary-fg) 26%, transparent);
    background: color-mix(in oklab, var(--ui-primary-fg) 13%, transparent);
    color: var(--ui-primary-fg);
}

.agent-assistant-message.is-user .agent-assistant-message-link {
    color: var(--ui-primary-fg);
}

.agent-assistant-message.is-user .agent-assistant-message-blockquote {
    border-left-color: color-mix(in oklab, var(--ui-primary-fg) 45%, transparent);
}

.agent-assistant-message.is-user .agent-assistant-message-rule {
    border-top-color: color-mix(in oklab, var(--ui-primary-fg) 28%, transparent);
}

.agent-assistant-message.is-system .agent-assistant-message-inline-code,
.agent-assistant-message.is-system .agent-assistant-message-code-block {
    border-color: color-mix(in oklab, var(--ui-error) 28%, transparent);
    background: color-mix(in oklab, var(--ui-error) 8%, var(--ui-bg) 92%);
    color: var(--ui-error);
}

.agent-assistant-message.is-system .agent-assistant-message-link {
    color: var(--ui-error);
}

.agent-assistant-message.is-system .agent-assistant-message-blockquote {
    border-left-color: color-mix(in oklab, var(--ui-error) 38%, transparent);
}

.agent-assistant-message.is-system .agent-assistant-message-rule {
    border-top-color: color-mix(in oklab, var(--ui-error) 24%, transparent);
}

.agent-assistant-message-copy {
    flex: 0 0 auto;
    width: 1.5rem;
    min-width: 1.5rem;
    height: 1.5rem;
    min-height: 1.5rem;
    margin-top: 0.15rem;
    color: var(--ui-text-muted);
    user-select: none;
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
    padding: 0.55rem 0.7rem 0.3rem;
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
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0 0.4rem 0.4rem;
}

.agent-assistant-composer-switchers {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
}

.agent-assistant-setup-footer {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.6rem 0.75rem;
    border-top: 1px solid var(--ui-border);
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
    padding: var(--app-assistant-image-preview-padding);
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
    max-width: min(var(--app-assistant-image-preview-max-viewport-width), var(--app-assistant-image-preview-max-width));
    max-height: var(--app-assistant-image-preview-content-max-height);
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
}

.agent-assistant-image-preview-image {
    display: block;
    max-width: min(var(--app-assistant-image-preview-max-viewport-width), var(--app-assistant-image-preview-max-width));
    max-height: var(--app-assistant-image-preview-image-max-height);
    border: 1px solid color-mix(in oklab, var(--ui-border) 72%, transparent);
    border-radius: var(--ui-radius);
    background: var(--ui-bg);
    box-shadow: var(--app-pdf-popover-shadow);
    object-fit: contain;
    user-select: none;
}

.agent-assistant-image-preview-caption {
    max-width: min(var(--app-assistant-image-preview-max-viewport-width), var(--app-assistant-image-preview-max-width));
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
    left: var(--app-assistant-image-preview-control-offset);
}

.agent-assistant-image-preview-nav.is-next {
    right: var(--app-assistant-image-preview-control-offset);
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
        width: min(100vw, var(--app-assistant-panel-default-width));
        flex: none;
        max-width: none;
        box-shadow: var(--app-pdf-context-menu-panel-shadow);
    }

    .agent-assistant-resizer {
        display: none;
    }
}
</style>
