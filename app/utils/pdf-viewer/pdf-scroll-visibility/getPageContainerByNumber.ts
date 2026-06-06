

export function getPageContainerByNumber(
    container: HTMLElement,
    pageNumber: number,
) {
    if (!Number.isFinite(pageNumber)) {
        return null;
    }

    const normalizedPageNumber = Math.max(1, Math.floor(pageNumber));
    return container.querySelector<HTMLElement>(
        `.page_container[data-page="${normalizedPageNumber}"]`,
    );
}
