interface IShapeOverlayVisibilityOptions {
    hasDrawingShape: boolean;
    hasPageShapes: boolean;
    isPageVisualReady: boolean;
    isShapeToolActive: boolean;
}

export function shouldShowShapeOverlay(options: IShapeOverlayVisibilityOptions) {
    if (options.hasDrawingShape) {
        return true;
    }

    return options.isPageVisualReady
        && (options.hasPageShapes || options.isShapeToolActive);
}
