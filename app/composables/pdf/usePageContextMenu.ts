
import { usePositionedMenu } from '@app/composables/usePositionedMenu';

interface IPageContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    pages: number[];
}

export const usePageContextMenu = () => {
    const createInitialPageContextMenuState = (): IPageContextMenuState => ({
        visible: false,
        x: 0,
        y: 0,
        pages: [],
    });
    const {
        menu: pageContextMenu,
        menuStyle: pageContextMenuStyle,
        showPositionedMenu,
        resetMenu,
    } = usePositionedMenu<IPageContextMenuState>(
        '.page-context-menu',
        createInitialPageContextMenuState,
    );

    function showPageContextMenu(payload: {
        clientX: number;
        clientY: number;
        pages: number[];
    }) {
        const fallbackWidth = 300;
        const estimatedHeight = 280;
        showPositionedMenu({
            x: payload.clientX,
            y: payload.clientY,
            fallbackWidth,
            fallbackHeight: estimatedHeight,
            buildState: position => ({
                visible: true,
                x: position.x,
                y: position.y,
                pages: payload.pages,
            }),
        });
    }

    function closePageContextMenu() {
        if (!pageContextMenu.value.visible) {
            return;
        }
        resetMenu();
    }

    return {
        pageContextMenu,
        pageContextMenuStyle,
        showPageContextMenu,
        closePageContextMenu,
    };
};
