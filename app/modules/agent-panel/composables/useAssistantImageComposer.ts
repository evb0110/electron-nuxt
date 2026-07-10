import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { IAgentAssistantImageAttachment } from '@contracts/agent';
import type { TTranslateFn } from '@i18n-app';
import {
    ASSISTANT_IMAGE_SIZE_LIMIT_LABEL,
    buildComposerImageAttachments,
    buildExpandedImagePreview,
    getClipboardImageFiles,
    navigateExpandedImagePreview,
    type IExpandedImagePreview,
    type TAssistantComposerImageError,
} from '@app/modules/agent-panel/utils/assistantImageAttachments';

export const useAssistantImageComposer = (options: {
    composerError: Ref<string>;
    composerImages: Ref<IAgentAssistantImageAttachment[]>;
    isSending: Ref<boolean>;
    isTurnActive: ComputedRef<boolean>;
    t: TTranslateFn;
}) => {
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
        return preview.images.length <= 1
            ? item.name
            : options.t('assistant.imagePreviewPosition', {
                name: item.name,
                current: preview.index + 1,
                total: preview.images.length,
            });
    });
    const formatError = (error: TAssistantComposerImageError | null) => {
        if (!error) {
            return '';
        }
        if (error.type === 'unsupported') {
            return options.t('assistant.imageUnsupported', { name: error.name });
        }
        if (error.type === 'too-large') {
            return options.t('assistant.imageTooLarge', {
                name: error.name,
                size: ASSISTANT_IMAGE_SIZE_LIMIT_LABEL,
            });
        }
        if (error.type === 'limit') {
            return options.t('assistant.imageAttachmentLimit', { count: error.count });
        }
        return options.t('assistant.imageReadFailed', { name: error.name });
    };
    const addImages = async (files: File[]) => {
        if (files.length === 0 || options.isSending.value) {
            return;
        }
        const result = await buildComposerImageAttachments({
            files,
            existingImages: options.composerImages.value,
            fallbackName: index => options.t('assistant.imageAttachmentFallbackName', { count: index + 1 }),
        });
        options.composerImages.value = result.images;
        options.composerError.value = formatError(result.error);
    };
    const handleComposerPaste = (event: ClipboardEvent) => {
        const imageFiles = getClipboardImageFiles(event.clipboardData);
        if (imageFiles.length === 0) {
            return;
        }
        event.preventDefault();
        if (options.isTurnActive.value) {
            options.composerError.value = options.t('assistant.imagePasteBusy');
            return;
        }
        void addImages(imageFiles);
    };
    const removeComposerImage = (imageId: string) => {
        options.composerImages.value = options.composerImages.value.filter(image => image.id !== imageId);
        options.composerError.value = '';
    };
    const expandImage = (images: readonly IAgentAssistantImageAttachment[] | undefined, selectedImageId: string) => {
        if (images) {
            expandedImage.value = buildExpandedImagePreview(images, selectedImageId);
        }
    };
    const closeExpandedImage = () => {
        expandedImage.value = null;
    };
    const navigateExpandedImage = (direction: -1 | 1) => {
        const preview = expandedImage.value;
        if (preview && preview.images.length > 1) {
            expandedImage.value = navigateExpandedImagePreview(preview, direction);
        }
    };
    const handleExpandedImageKeydown = (event: KeyboardEvent) => {
        if (!expandedImage.value) {
            return;
        }
        const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : null;
        if (event.key !== 'Escape' && direction === null) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (direction === null) {
            closeExpandedImage();
        } else {
            navigateExpandedImage(direction);
        }
    };
    return {
        closeExpandedImage,
        expandImage,
        expandedImage,
        expandedImageCaption,
        expandedImageItem,
        handleComposerPaste,
        handleExpandedImageKeydown,
        navigateExpandedImage,
        removeComposerImage,
    };
};
