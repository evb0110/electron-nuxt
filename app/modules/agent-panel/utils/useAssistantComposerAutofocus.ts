import type {
    ComputedRef,
    Ref,
} from 'vue';

export const useAssistantComposerAutofocus = (
    composerInputRef: Ref<HTMLTextAreaElement | null>,
    canFocusComposerInput: ComputedRef<boolean>,
) => {
    let shouldAutofocusComposerInput = true;

    async function focusComposerInputOnce() {
        if (!shouldAutofocusComposerInput || !canFocusComposerInput.value) {
            return;
        }

        await nextTick();

        const input = composerInputRef.value;
        if (!shouldAutofocusComposerInput || !canFocusComposerInput.value || !input || input.disabled) {
            return;
        }

        input.focus({ preventScroll: true });
        shouldAutofocusComposerInput = false;
    }

    watch(canFocusComposerInput, () => {
        void focusComposerInputOnce();
    }, { flush: 'post' });

    onMounted(() => {
        void focusComposerInputOnce();
    });
};
