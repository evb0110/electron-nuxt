export function resolvePageTargets(viewerContainer: HTMLElement | null, pageNumbers: readonly number[]) {
    if (!viewerContainer) {
        return new Map<number, HTMLElement>();
    }

    const targets = new Map<number, HTMLElement>();
    for (const pageNumber of pageNumbers) {
        const pageElement = viewerContainer.querySelector<HTMLElement>(
            `.page_container[data-page="${pageNumber}"]`,
        );
        if (pageElement) {
            targets.set(pageNumber, pageElement);
        }
    }
    return targets;
}
