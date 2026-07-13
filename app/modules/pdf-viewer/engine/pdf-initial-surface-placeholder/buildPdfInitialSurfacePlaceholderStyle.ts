export function buildPdfInitialSurfacePlaceholderStyle(options: {
    pageStyle: Record<string, string> | null;
    scaledMargin: number;
    viewportOwnsPadding?: boolean;
}) {
    if (!options.pageStyle) {
        return null;
    }
    return {
        ...options.pageStyle,
        marginTop: `${options.viewportOwnsPadding === true ? 0 : options.scaledMargin}px`,
    };
}
