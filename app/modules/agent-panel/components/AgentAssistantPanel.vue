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
import type {
    IAgentAssistantChatScope,
    IAgentAssistantChatMessage,
    IAgentAssistantEvent,
    IAgentAssistantImageAttachment,
    IAgentAssistantState,
    TAgentAssistantEffort,
    TAgentAssistantLoginMode,
    TAgentAssistantMessageRole,
    TAgentAssistantPresetId,
    TAgentAssistantProviderId,
    TAgentAssistantSpeedMode,
} from '@contracts/agent';
import {
    ASSISTANT_DEFAULT_EFFORT,
    ASSISTANT_DEFAULT_SPEED_MODE,
    ASSISTANT_SPEED_MODES,
} from '@contracts/agentModels';
import AssistantEffortSwitcher from '@app/modules/agent-panel/components/AssistantEffortSwitcher.vue';
import AssistantModelSwitcher from '@app/modules/agent-panel/components/AssistantModelSwitcher.vue';
import AssistantSpeedSwitcher from '@app/modules/agent-panel/components/AssistantSpeedSwitcher.vue';
import {
    cloneAssistantScope,
    createSelectedAssistantStatus,
    getStateScopeKey,
    normalizeEffortValue,
    normalizeModelValue,
    normalizeProviderValue,
    normalizeSpeedModeValue,
    providerDefaultEffort,
    providerDefaultSpeedMode,
    speedModesForProviderStatus,
} from '@app/modules/agent-panel/utils/assistantSelectionState';
import { createEmptyAssistantState } from '@app/modules/agent-panel/utils/createEmptyAssistantState';
import {
    ASSISTANT_PRESETS,
    type IAssistantPreset,
} from '@app/modules/agent-panel/utils/assistantPresets';
import {
    persistAssistantSelection,
    preferredAssistantModel,
    readAssistantSelectionPreference,
    selectedAssistantModelForProvider,
} from '@app/modules/agent-panel/utils/assistantSelectionPreference';
import { useAssistantComposerAutofocus } from '@app/modules/agent-panel/utils/useAssistantComposerAutofocus';
import {
    ASSISTANT_IMAGE_SIZE_LIMIT_LABEL,
    buildComposerImageAttachments,
    buildExpandedImagePreview,
    getClipboardImageFiles,
    navigateExpandedImagePreview,
    type IExpandedImagePreview,
    type TAssistantComposerImageError,
} from '@app/modules/agent-panel/utils/assistantImageAttachments';
import { isAssistantSelectionLocked } from '@app/modules/agent-panel/utils/isAssistantSelectionLocked';
import { formatAssistantMessage } from '@app/modules/agent-panel/utils/formatAssistantMessage';
import { getAgentAssistantPanelView } from '@app/modules/workspace-shell/public';
import { guardAsync } from '@app/utils/asyncGuard';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
import { getAgentCapability } from '@app/utils/getAgentCapability';
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
const ASSISTANT_AUTO_REFRESH_MIN_INTERVAL_MS = 2500;
const ASSISTANT_SCROLL_STICKY_THRESHOLD_PX = 96;
const EMPTY_ASSISTANT_MESSAGE_BLOCKS: ReturnType<typeof formatAssistantMessage> = [];

const assistantSelectionStorage = defaultWindow?.localStorage;
const initialAssistantSelectionPreference = readAssistantSelectionPreference(assistantSelectionStorage);
const initialSelectedProvider = initialAssistantSelectionPreference?.provider ?? 'codex';
const initialSelectedModel = preferredAssistantModel(
    initialAssistantSelectionPreference,
    initialSelectedProvider,
);
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
const composerInputRef = ref<HTMLTextAreaElement | null>(null);
const state = ref<IAgentAssistantState | null>(null);
const selectedProvider = ref<TAgentAssistantProviderId>(initialSelectedProvider);
const selectedModel = ref(initialSelectedModel);
const hasLocalModelSelection = ref(Boolean(initialAssistantSelectionPreference?.modelsByProvider[initialSelectedProvider]));
const selectedEffort = ref<TAgentAssistantEffort>(ASSISTANT_DEFAULT_EFFORT);
const hasLocalEffortSelection = ref(false);
const selectedSpeedMode = ref<TAgentAssistantSpeedMode>(ASSISTANT_DEFAULT_SPEED_MODE);
const hasLocalSpeedModeSelection = ref(false);
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

const emptyState = computed<IAgentAssistantState>(() => createEmptyAssistantState({
    chatScope,
    selectedProvider: selectedProvider.value,
    selectedModel: selectedModel.value,
    selectedEffort: selectedEffort.value,
    selectedSpeedMode: selectedSpeedMode.value,
}));
const status = computed(() => (state.value ?? emptyState.value).status);
const availableEfforts = computed(() => status.value.availableEfforts ?? []);
const availableSpeedModes = computed(() => {
    const providerStatus = status.value.providers.find(provider => provider.id === selectedProvider.value);
    if (providerStatus) {
        return speedModesForProviderStatus(providerStatus);
    }
    const speedModes = status.value.availableSpeedModes ?? [];
    return speedModes.length > 0 ? [...speedModes] : [...ASSISTANT_SPEED_MODES];
});
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
const hasPendingComposer = computed(() => panelView.value === 'checking' && Boolean(chatScope));
const canFocusComposerInput = computed(() => hasComposer.value && !isSending.value);
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

function createOptimisticAssistantState(
    provider: TAgentAssistantProviderId,
    model: string,
    effort: TAgentAssistantEffort,
    speedMode: TAgentAssistantSpeedMode,
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
        status: createSelectedAssistantStatus(baseState.status, providerStatus, model, effort, speedMode),
        messages: shouldKeepMessages ? baseState.messages : [],
    };
}

function applyOptimisticSelection(
    provider: TAgentAssistantProviderId,
    model: string,
    effort: TAgentAssistantEffort,
    speedMode: TAgentAssistantSpeedMode,
    keepMessages: boolean,
) {
    const optimisticState = createOptimisticAssistantState(provider, model, effort, speedMode, keepMessages);
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
        speedMode: selectedSpeedMode.value,
    };
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
    const needsSpeedModeOverride = hasLocalSpeedModeSelection.value && nextState.status.speedMode !== selectedSpeedMode.value;
    const adjustedState = providerStatus && (needsModelOverride || needsEffortOverride || needsSpeedModeOverride)
        ? {
            ...nextState,
            status: createSelectedAssistantStatus(
                nextState.status,
                providerStatus,
                needsModelOverride ? selectedModel.value : nextState.status.model,
                needsEffortOverride ? selectedEffort.value : nextState.status.effort,
                needsSpeedModeOverride ? selectedSpeedMode.value : nextState.status.speedMode,
            ),
        }
        : nextState;
    selectedProvider.value = adjustedState.status.provider;
    selectedModel.value = adjustedState.status.model;
    selectedEffort.value = normalizeEffortValue(adjustedState.status.effort)
        ?? providerDefaultEffort(adjustedState.status.providers, adjustedState.status.provider);
    selectedSpeedMode.value = resolveSelectedSpeedModeFromState(adjustedState, providerStatus);
    state.value = adjustedState;
    hasLoadedState.value = true;
    isSending.value = adjustedState.status.runtimeState === 'busy';
    if (shouldScrollToBottom) {
        void nextTick(scrollAssistantMessagesToBottom);
    }
}

function resolveSelectedSpeedModeFromState(
    nextState: IAgentAssistantState,
    providerStatus: IAgentAssistantState['status']['providers'][number] | undefined,
) {
    const stateSpeedMode = normalizeSpeedModeValue(nextState.status.speedMode)
        ?? providerDefaultSpeedMode(nextState.status.providers, nextState.status.provider);
    return nextState.status.provider === 'codex'
        && !hasLocalSpeedModeSelection.value
        && providerStatus?.availableSpeedModes
        && !providerStatus.availableSpeedModes.includes(ASSISTANT_DEFAULT_SPEED_MODE)
        ? ASSISTANT_DEFAULT_SPEED_MODE
        : stateSpeedMode;
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
    const nextState = await getAgentCapability().getAssistantState(createAssistantStateRequest());
    if (generation === stateGeneration) {
        applyState(nextState);
    }
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
    const nextModel = selectedAssistantModelForProvider(
        assistantSelectionStorage,
        nextProvider,
        status.value.providers,
    );
    selectedProvider.value = nextProvider;
    selectedModel.value = nextModel;
    hasLocalModelSelection.value = true;
    selectedEffort.value = providerDefaultEffort(status.value.providers, nextProvider);
    hasLocalEffortSelection.value = false;
    selectedSpeedMode.value = providerDefaultSpeedMode(status.value.providers, nextProvider);
    hasLocalSpeedModeSelection.value = false;
    persistAssistantSelection(assistantSelectionStorage, nextProvider, nextModel);
    sendGeneration += 1;
    applyOptimisticSelection(nextProvider, selectedModel.value, selectedEffort.value, selectedSpeedMode.value, false);
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
    persistAssistantSelection(assistantSelectionStorage, selectedProvider.value, nextModel);
    applyOptimisticSelection(selectedProvider.value, nextModel, selectedEffort.value, selectedSpeedMode.value, true);
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
    applyOptimisticSelection(selectedProvider.value, selectedModel.value, nextEffort, selectedSpeedMode.value, true);
}

function updateSpeedMode(value: unknown) {
    if (assistantSelectionLocked.value) {
        return;
    }
    const nextSpeedMode = normalizeSpeedModeValue(value);
    if (!nextSpeedMode || nextSpeedMode === selectedSpeedMode.value) {
        return;
    }
    selectedSpeedMode.value = nextSpeedMode;
    hasLocalSpeedModeSelection.value = true;
    applyOptimisticSelection(selectedProvider.value, selectedModel.value, selectedEffort.value, nextSpeedMode, true);
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
        const result = await getAgentCapability().installAssistantCodex();
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
        const result = await getAgentCapability().startAssistantLogin({ mode });
        applyState(result.state);
        deviceCode.value = result.userCode ?? '';
    } finally {
        isLoggingIn.value = false;
        loginMode.value = null;
    }
}

async function cancelLogin() {
    applyState(await getAgentCapability().cancelAssistantLogin());
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

function fallbackImageName(index: number) {
    return t('assistant.imageAttachmentFallbackName', { count: index + 1 });
}

function formatComposerImageError(error: TAssistantComposerImageError | null) {
    if (!error) {
        return '';
    }
    if (error.type === 'unsupported') {
        return t('assistant.imageUnsupported', { name: error.name });
    }
    if (error.type === 'too-large') {
        return t('assistant.imageTooLarge', {
            name: error.name,
            size: ASSISTANT_IMAGE_SIZE_LIMIT_LABEL,
        });
    }
    if (error.type === 'limit') {
        return t('assistant.imageAttachmentLimit', { count: error.count });
    }
    return t('assistant.imageReadFailed', { name: error.name });
}

async function addComposerImages(files: File[]) {
    if (files.length === 0 || isSending.value) {
        return;
    }

    const result = await buildComposerImageAttachments({
        files,
        existingImages: composerImages.value,
        fallbackName: fallbackImageName,
    });
    composerImages.value = result.images;
    composerError.value = formatComposerImageError(result.error);
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
    expandedImage.value = navigateExpandedImagePreview(preview, direction);
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

interface IAssistantSubmitPayload {
    text: string;
    attachments?: IAgentAssistantImageAttachment[];
    presetId?: TAgentAssistantPresetId;
}

async function submitAssistantPayload(
    payload: IAssistantSubmitPayload,
    errorTitle: string,
    onSendError?: () => void,
) {
    if (!chatScope) {
        return;
    }
    const generation = sendGeneration;
    const attachments = payload.attachments ?? [];
    isSending.value = true;
    try {
        const result = await getAgentCapability().sendAssistantMessage({
            text: payload.text,
            scope: cloneAssistantScope(chatScope),
            provider: selectedProvider.value,
            model: selectedModel.value,
            effort: selectedEffort.value,
            speedMode: selectedSpeedMode.value,
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(payload.presetId ? { presetId: payload.presetId } : {}),
        });
        if (generation !== sendGeneration) {
            return;
        }
        applyState(result.state);
    } catch (error) {
        if (generation === sendGeneration) {
            onSendError?.();
            handleAssistantActionError(error, {
                title: errorTitle,
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

function presetLabel(presetId: TAgentAssistantPresetId) {
    if (presetId === 'add-bookmarks') {
        return t('assistant.presetAddBookmarks');
    }
    if (presetId === 'number-pages') {
        return t('assistant.presetNumberPages');
    }
    return t('assistant.presetCheckOcr');
}

function sendPreset(preset: IAssistantPreset) {
    if (!chatScope || isSending.value) {
        return;
    }
    void submitAssistantPayload(
        {
            text: presetLabel(preset.id),
            presetId: preset.id, 
        },
        'Failed to send assistant preset',
    );
}

async function sendMessage() {
    if (!canSend.value) {
        return;
    }
    if (!chatScope) {
        return;
    }
    const text = draft.value.trim();
    const attachments = composerImages.value.map(image => ({ ...image }));
    draft.value = '';
    composerImages.value = [];
    composerError.value = '';
    await submitAssistantPayload(
        {
            text,
            attachments, 
        },
        'Failed to send assistant message',
        () => {
            draft.value = text;
            composerImages.value = attachments;
        },
    );
}

function handleSendMessage() {
    void sendMessage();
}

async function interrupt() {
    if (!chatScope) {
        return;
    }
    sendGeneration += 1;
    applyState(await getAgentCapability().interruptAssistant(createAssistantStateRequest()));
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
        applyState(await getAgentCapability().resetAssistantChat(createAssistantStateRequest()));
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
useAssistantComposerAutofocus(composerInputRef, canFocusComposerInput);

onMounted(() => {
    unsubscribe = getAgentCapability().onAssistantEvent(handleAssistantEvent);
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

<style scoped src="./AgentAssistantPanel.shell.css"></style>

<style scoped src="./AgentAssistantPanel.composer.css"></style>
