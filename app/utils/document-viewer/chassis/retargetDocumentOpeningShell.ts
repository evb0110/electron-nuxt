interface IDocumentOpeningShellVisual {
    committedViewportPosition: unknown;
    openingPageFrame: {readonly pageNumber: number} | null;
    openingPageGeometry: {readonly pageNumber: number} | null;
    presentation: string;
}

export function retargetDocumentOpeningShell<TVisual extends IDocumentOpeningShellVisual>(
    visual: TVisual,
    pageNumber: number,
): TVisual {
    return {
        ...visual,
        presentation: 'page-shell',
        openingPageGeometry: visual.openingPageGeometry === null
            ? null
            : Object.freeze({
                ...visual.openingPageGeometry,
                pageNumber,
            }),
        openingPageFrame: visual.openingPageFrame === null
            ? null
            : Object.freeze({
                ...visual.openingPageFrame,
                pageNumber,
            }),
        committedViewportPosition: null,
    };
}
