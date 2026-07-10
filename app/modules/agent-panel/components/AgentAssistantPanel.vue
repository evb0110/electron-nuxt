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
                :class="{ 'is-muted': hasPendingComposer }"
            >
                <span class="agent-assistant-glyph">
                    <UIcon
                        :name="hasPendingComposer ? 'i-ph-lightbulb' : 'i-ph-circle-notch'"
                        class="agent-assistant-glyph-icon"
                        :class="{ 'is-spinning': !hasPendingComposer }"
                    />
                </span>
                <h2>{{ hasPendingComposer ? emptyTitle : t('assistant.checkingTitle') }}</h2>
                <p>{{ hasPendingComposer ? emptyDescription : t('assistant.checkingDescription') }}</p>
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
                        <div
                            v-if="hasActiveDocument"
                            class="agent-assistant-presets"
                        >
                            <button
                                v-for="preset in ASSISTANT_PRESETS"
                                :key="preset.id"
                                type="button"
                                class="agent-assistant-preset"
                                :disabled="isSending"
                                @click="sendPreset(preset)"
                            >
                                <UIcon
                                    :name="preset.icon"
                                    class="agent-assistant-preset-icon"
                                />
                                <span class="agent-assistant-preset-label">{{ presetLabel(preset.id) }}</span>
                            </button>
                        </div>
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
                        <div
                            v-if="hasActiveDocument && hasMessages"
                            class="agent-assistant-composer-presets"
                        >
                            <button
                                v-for="preset in ASSISTANT_PRESETS"
                                :key="preset.id"
                                type="button"
                                class="agent-assistant-preset"
                                :disabled="isSending"
                                @click="sendPreset(preset)"
                            >
                                <UIcon
                                    :name="preset.icon"
                                    class="agent-assistant-preset-icon"
                                />
                                <span class="agent-assistant-preset-label">{{ presetLabel(preset.id) }}</span>
                            </button>
                        </div>
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
                                ref="composerInputRef"
                                v-model="draft"
                                class="agent-assistant-input"
                                :placeholder="placeholderText"
                                rows="3"
                                :disabled="!hasComposer"
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
                                        v-if="hasLoadedState && availableEfforts.length > 0"
                                        :efforts="availableEfforts"
                                        :selected-effort="selectedEffort"
                                        :disabled="assistantSelectionLocked"
                                        side="top"
                                        @select-effort="updateEffort"
                                    />
                                    <AssistantSpeedSwitcher
                                        v-if="hasLoadedState && availableSpeedModes.length > 1"
                                        :modes="availableSpeedModes"
                                        :selected-mode="selectedSpeedMode"
                                        :disabled="assistantSelectionLocked"
                                        side="top"
                                        @select-mode="updateSpeedMode"
                                    />
                                </div>
                                <div class="agent-assistant-composer-submit-actions">
                                    <UButton
                                        v-if="isSending"
                                        :aria-label="t('assistant.stop')"
                                        icon="i-ph-stop-circle"
                                        color="neutral"
                                        variant="outline"
                                        size="sm"
                                        type="button"
                                        @click="handleInterrupt"
                                    />
                                    <UButton
                                        :aria-label="sendButtonAriaLabel"
                                        icon="i-ph-arrow-up"
                                        :color="canSend ? 'primary' : 'neutral'"
                                        :variant="canSend ? 'solid' : 'soft'"
                                        size="sm"
                                        type="submit"
                                        :disabled="!canSend"
                                    />
                                </div>
                            </div>
                        </div>
                    </form>
                </template>
            </template>

            <div
                v-if="!hasComposer"
                class="agent-assistant-composer agent-assistant-composer-reserve"
                :class="{ 'is-visible': hasPendingComposer }"
                aria-hidden="true"
            >
                <div class="agent-assistant-composer-field">
                    <textarea
                        class="agent-assistant-input"
                        :placeholder="placeholderText"
                        rows="3"
                        tabindex="-1"
                        disabled
                    />
                    <div class="agent-assistant-composer-actions">
                        <div
                            v-if="hasPendingComposer"
                            class="agent-assistant-composer-switchers"
                        >
                            <AssistantModelSwitcher
                                :providers="status.providers"
                                :selected-provider="selectedProvider"
                                :selected-model="selectedModel"
                                :is-switching="false"
                                disabled
                                side="top"
                                @select-provider="updateProvider"
                                @select-model="updateModel"
                            />
                            <AssistantEffortSwitcher
                                v-if="availableEfforts.length > 0"
                                :efforts="availableEfforts"
                                :selected-effort="selectedEffort"
                                disabled
                                side="top"
                                @select-effort="updateEffort"
                            />
                            <AssistantSpeedSwitcher
                                v-if="availableSpeedModes.length > 1"
                                :modes="availableSpeedModes"
                                :selected-mode="selectedSpeedMode"
                                disabled
                                side="top"
                                @select-mode="updateSpeedMode"
                            />
                        </div>
                        <div
                            v-else
                            class="agent-assistant-composer-switchers"
                        >
                            <span class="agent-assistant-composer-control-reserve" />
                            <span class="agent-assistant-composer-control-reserve is-short" />
                            <span class="agent-assistant-composer-control-reserve is-short" />
                        </div>
                        <UButton
                            v-if="hasPendingComposer"
                            :aria-label="t('assistant.send')"
                            icon="i-ph-arrow-up"
                            color="neutral"
                            variant="soft"
                            size="sm"
                            type="button"
                            disabled
                        />
                        <span
                            v-else
                            class="agent-assistant-composer-send-reserve"
                        />
                    </div>
                </div>
            </div>

            <div
                v-if="hasLoadedState && !hasComposer && panelView !== 'checking' && panelView !== 'unsupported'"
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
                    v-if="availableEfforts.length > 0"
                    :efforts="availableEfforts"
                    :selected-effort="selectedEffort"
                    :disabled="assistantSelectionLocked"
                    side="top"
                    @select-effort="updateEffort"
                />
                <AssistantSpeedSwitcher
                    v-if="availableSpeedModes.length > 1"
                    :modes="availableSpeedModes"
                    :selected-mode="selectedSpeedMode"
                    :disabled="assistantSelectionLocked"
                    side="top"
                    @select-mode="updateSpeedMode"
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
import type { IAgentAssistantPanelControllerProps } from '@app/modules/agent-panel/composables/useAgentAssistantPanelController';
import AssistantEffortSwitcher from '@app/modules/agent-panel/components/AssistantEffortSwitcher.vue';
import AssistantModelSwitcher from '@app/modules/agent-panel/components/AssistantModelSwitcher.vue';
import AssistantSpeedSwitcher from '@app/modules/agent-panel/components/AssistantSpeedSwitcher.vue';
import { createAgentAssistantPanelControllerProps } from '@app/modules/agent-panel/composables/createAgentAssistantPanelControllerProps';
import { useAgentAssistantPanelController } from '@app/modules/agent-panel/composables/useAgentAssistantPanelController';

const {
    activeDocumentName = null,
    chatScope = null,
    hasActiveDocument = false,
    hasAnyDocument = false,
    width = undefined,
    isResizing = false,
} = defineProps<IAgentAssistantPanelControllerProps>();

const emit = defineEmits<{
    close: [];
    'resize-start': [event: PointerEvent];
}>();

const props = createAgentAssistantPanelControllerProps(() => ({
    activeDocumentName: activeDocumentName ?? null,
    chatScope: chatScope ?? null,
    hasActiveDocument: hasActiveDocument ?? false,
    hasAnyDocument: hasAnyDocument ?? false,
    width,
    isResizing: isResizing ?? false,
}));

const {
    ASSISTANT_PRESETS,
    assistantSelectionLocked,
    availableEfforts,
    availableSpeedModes,
    canResetChat,
    canSend,
    closeExpandedImage,
    composerError,
    composerImages,
    composerInputRef,
    copyMessageIcon,
    copyMessageTooltip,
    deviceCode,
    draft,
    emptyDescription,
    emptyTitle,
    expandImage,
    expandedImage,
    expandedImageCaption,
    expandedImageItem,
    handleCancelLogin,
    handleComposerPaste,
    handleCopyMessageText,
    handleInstallCodex,
    handleInterrupt,
    handleRefreshState,
    handleResetChat,
    handleSendMessage,
    handleStartLogin,
    hasComposer,
    hasLoadedState,
    hasMessages,
    hasPendingComposer,
    headerIcon,
    headerTitle,
    installButtonLabel,
    installDescription,
    installProgress,
    installTitle,
    isClaudeProvider,
    isInstalling,
    isLoggingIn,
    isResetting,
    isSending,
    isSwitchingAssistant,
    isTurnActive,
    loginMode,
    messagesRef,
    navigateExpandedImage,
    panelRef,
    panelView,
    placeholderText,
    presetLabel,
    removeComposerImage,
    renderedMessages,
    roleLabel,
    selectedEffort,
    selectedModel,
    selectedProvider,
    selectedSpeedMode,
    sendButtonAriaLabel,
    sendPreset,
    signInDescription,
    signInTitle,
    status,
    t,
    turnStatusText,
    updateEffort,
    updateModel,
    updateProvider,
    updateSpeedMode,
    widthVar,
} = useAgentAssistantPanelController(props);
</script>

<style scoped src="./AgentAssistantPanel.shell.css"></style>

<style scoped src="./AgentAssistantPanel.composer.css"></style>
