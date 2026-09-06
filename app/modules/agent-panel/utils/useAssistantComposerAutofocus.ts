import type {
    ComputedRef,
    Ref,
} from 'vue';

export const useAssistantComposerAutofocus = (
    composerInputRef: Ref<HTMLTextAreaElement | null>,
    canFocusComposerInput: ComputedRef<boolean>,
) => {
    let shouldAutofocusComposerInput = true as boolean;
    const canAutofocusComposerInput = () => shouldAutofocusComposerInput && canFocusComposerInput.value;

    async function focusComposerInputOnce() {
        if (!canAutofocusComposerInput()) {
            return;
        }

        await nextTick();

        const input = composerInputRef.value;
        if (!canAutofocusComposerInput() || !input || input.disabled) {
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
