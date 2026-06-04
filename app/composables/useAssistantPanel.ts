export const useAssistantPanel = () => {
    const isOpen = useState('assistant-panel:open', () => false);
    const isEnabled = useState('assistant-panel:enabled', () => false);
    const hasActiveDocument = useState('assistant-panel:has-active-document', () => false);

    const isAvailable = computed(() => isEnabled.value && hasActiveDocument.value);

    const open = () => {
        if (isAvailable.value) {
            isOpen.value = true;
        }
    };

    const close = () => {
        isOpen.value = false;
    };

    const toggle = () => {
        if (isOpen.value) {
            close();
        } else {
            open();
        }
    };

    return {
        isOpen,
        isEnabled,
        hasActiveDocument,
        isAvailable,
        open,
        close,
        toggle,
    };
};
