import type { IDocumentPageSlotRegistry } from '@app/utils/document-viewer/page-slots/createDocumentPageSlotRegistry';

export type TDocumentPageVisual = 'none' | 'skeleton' | 'stale' | 'fresh';

export interface IDocumentViewerRenderSession {
    readonly ownerId: string;
    readonly pageSlots: ReturnType<IDocumentPageSlotRegistry['createOwner']>;
    beginPageRender(pageNumber: number, hasRetainedVisual: boolean): number;
    commitPageRender(pageNumber: number, generation: number): boolean;
    failPageRender(pageNumber: number, generation: number): boolean;
    runPageRender<T>(
        pageNumber: number,
        hasRetainedVisual: boolean,
        render: (generation: number) => Promise<T>,
    ): Promise<{
        committed: boolean;
        generation: number;
        value: T
    }>;
    getPageVisual(pageNumber: number): TDocumentPageVisual;
    resolveMountedPages(options: {
        currentPage: number;
        destinationPage?: number | undefined;
        pageCount: number;
        radius?: number | undefined;
    }): number[];
    dispose(): void;
}

export function createDocumentViewerRenderCoordinator(pageSlots: IDocumentPageSlotRegistry) {
    function createSession(ownerId: string): IDocumentViewerRenderSession {
        const ownedSlots = pageSlots.createOwner(ownerId);
        const visuals = new Map<number, {
            generation: number;
            visual: TDocumentPageVisual
        }>();
        let disposed = false;

        return {
            ownerId,
            pageSlots: ownedSlots,
            beginPageRender(pageNumber, hasRetainedVisual) {
                if (disposed) {
                    return -1;
                }
                const generation = (visuals.get(pageNumber)?.generation ?? 0) + 1;
                visuals.set(pageNumber, {
                    generation,
                    visual: hasRetainedVisual ? 'stale' : 'skeleton',
                });
                return generation;
            },
            commitPageRender(pageNumber, generation) {
                const state = visuals.get(pageNumber);
                if (disposed || state?.generation !== generation) {
                    return false;
                }
                state.visual = 'fresh';
                return true;
            },
            failPageRender(pageNumber, generation) {
                const state = visuals.get(pageNumber);
                if (disposed || state?.generation !== generation) {
                    return false;
                }
                state.visual = state.visual === 'stale' ? 'stale' : 'none';
                return true;
            },
            async runPageRender(pageNumber, hasRetainedVisual, render) {
                const generation = this.beginPageRender(pageNumber, hasRetainedVisual);
                try {
                    const value = await render(generation);
                    return {
                        committed: this.commitPageRender(pageNumber, generation),
                        generation,
                        value,
                    };
                } catch (error) {
                    this.failPageRender(pageNumber, generation);
                    throw error;
                }
            },
            getPageVisual: pageNumber => visuals.get(pageNumber)?.visual ?? 'none',
            resolveMountedPages({
                currentPage,
                destinationPage,
                pageCount,
                radius = 3,
            }) {
                const pages = new Set<number>();
                for (const anchor of [
                    currentPage,
                    destinationPage,
                ]) {
                    if (anchor === undefined) continue;
                    for (
                        let page = Math.max(1, anchor - radius);
                        page <= Math.min(pageCount, anchor + radius);
                        page += 1
                    ) pages.add(page);
                }
                return [...pages].sort((left, right) => left - right);
            },
            dispose() {
                if (disposed) {
                    return;
                }
                disposed = true;
                visuals.clear();
                ownedSlots.dispose();
            },
        };
    }

    return {createSession};
}
