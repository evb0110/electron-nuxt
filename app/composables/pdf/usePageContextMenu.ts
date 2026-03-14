
import { useContextMenuPosition } from '@app/composables/useContextMenuPosition';

interface IPageContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    pages: number[];
}

export const usePageContextMenu = () => {
    const { clampElementToViewport } = useContextMenuPosition();

    const pageContextMenu = ref<IPageContextMenuState>({
        visible: false,
        x: 0,
        y: 0,
        pages: [],
    });
    const contextMenuElement = computed(() => (
        typeof window === 'undefined'
            ? null
            : document.querySelector<HTMLElement>('.page-context-menu')
    ));

    const pageContextMenuStyle = computed(() => ({
        left: `${pageContextMenu.value.x}px`,
        top: `${pageContextMenu.value.y}px`,
    }));

    function positionPageContextMenu(
        x: number,
        y: number,
        fallbackWidth: number,
        fallbackHeight: number,
    ) {
        const clamped = clampElementToViewport(
            x,
            y,
            contextMenuElement.value,
            fallbackWidth,
            fallbackHeight,
        );
        pageContextMenu.value.x = clamped.x;
        pageContextMenu.value.y = clamped.y;
    }

    function showPageContextMenu(payload: {
        clientX: number;
        clientY: number;
        pages: number[];
    }) {
        const fallbackWidth = 300;
        const estimatedHeight = 280;
        const initialPosition = clampElementToViewport(
            payload.clientX,
            payload.clientY,
            contextMenuElement.value,
            fallbackWidth,
            estimatedHeight,
        );

        pageContextMenu.value = {
            visible: true,
            x: initialPosition.x,
            y: initialPosition.y,
            pages: payload.pages,
        };

        void nextTick(() => {
            if (!pageContextMenu.value.visible) {
                return;
            }
            positionPageContextMenu(
                payload.clientX,
                payload.clientY,
                fallbackWidth,
                estimatedHeight,
            );
        });
    }

    function closePageContextMenu() {
        if (!pageContextMenu.value.visible) {
            return;
        }
        pageContextMenu.value = {
            visible: false,
            x: 0,
            y: 0,
            pages: [],
        };
    }

    return {
        pageContextMenu,
        pageContextMenuStyle,
        showPageContextMenu,
        closePageContextMenu,
    };
};
