export type TVisualState = 'none' | 'skeleton' | 'fresh' | 'stale';

export interface IScrollRecord {
    author: 'ViewportAuthority' | 'user';
    intentId: string | null;
    reason: string;
    sequence: number;
    top: number;
}

export interface ISemanticAnchor {
    page: number;
    pageYFraction: number;
    viewportYFraction: number;
}

interface IIntentToken {
    documentRevision: number;
    geometryRevision: number;
    id: string;
    interactionEpoch: number;
}

interface IScheduledEvent {
    label: string;
    run: () => void;
}

interface IVisualRecord {
    documentId: string;
    generation: number;
    state: TVisualState;
}

export class viewportSimulation {
    readonly scrollWrites: IScrollRecord[] = [];
    readonly terminalOutcomes = new Map<string, 'cancelled' | 'settled'>();
    readonly visualTransitions: string[] = [];
    readonly mountedPages = new Set<number>();
    readonly exactRangeDeliveries: Array<{
        begin: number;
        end: number;
        bytes: number
    }> = [];

    documentId = 'document-1';
    documentRevision = 1;
    geometryRevision = 1;
    interactionEpoch = 0;
    scrollTop = 0;
    zoom = 1;
    renderEpoch = 1;
    pendingTargetPage: number | null = null;
    optionalWorkStarted = false;

    private active: {
        controller: AbortController;
        token: IIntentToken
    } | null = null;
    private intentCounter = 0;
    private sequence = 0;
    private readonly scheduled: IScheduledEvent[] = [];
    private readonly visuals = new Map<number, IVisualRecord>();
    private readonly pageTops = new Map<number, number>();
    private anchor: ISemanticAnchor = {
        page: 1,
        pageYFraction: 0,
        viewportYFraction: 0,
    };

    beginIntent(kind: string, targetPage?: number) {
        if (this.active) {
            this.active.controller.abort();
            this.finish(this.active.token.id, 'cancelled');
        }
        const id = `${kind}-${++this.intentCounter}`;
        const token: IIntentToken = {
            documentRevision: this.documentRevision,
            geometryRevision: this.geometryRevision,
            id,
            interactionEpoch: this.interactionEpoch,
        };
        this.active = {
            controller: new AbortController(),
            token,
        };
        this.pendingTargetPage = targetPage ?? null;
        return token;
    }

    schedule(token: IIntentToken, label: string, action: () => void) {
        this.scheduled.push({
            label,
            run: () => {
                if (!this.isCurrent(token)) {
                    return;
                }
                action();
            },
        });
    }

    flush(order: string[] = []) {
        const rank = new Map(order.map((label, index) => [
            label,
            index,
        ]));
        const events = this.scheduled.splice(0).sort((left, right) => (
            (rank.get(left.label) ?? Number.MAX_SAFE_INTEGER)
            - (rank.get(right.label) ?? Number.MAX_SAFE_INTEGER)
        ));
        events.forEach(event => event.run());
    }

    applyScroll(token: IIntentToken, top: number, reason: string) {
        if (!this.isCurrent(token)) {
            return false;
        }
        this.scrollTop = top;
        this.scrollWrites.push({
            author: 'ViewportAuthority',
            intentId: token.id,
            reason,
            sequence: ++this.sequence,
            top,
        });
        return true;
    }

    applyZoom(token: IIntentToken, zoom: number, cursorDocumentY: number, viewportY: number) {
        if (!this.isCurrent(token)) {
            return false;
        }
        this.zoom = zoom;
        return this.applyScroll(token, cursorDocumentY * zoom - viewportY, 'zoom-anchor');
    }

    userScroll(top: number) {
        this.interactionEpoch += 1;
        if (this.active) {
            this.active.controller.abort();
            this.finish(this.active.token.id, 'cancelled');
            this.active = null;
        }
        this.scrollTop = top;
        this.scrollWrites.push({
            author: 'user',
            intentId: null,
            reason: 'native-user-scroll',
            sequence: ++this.sequence,
            top,
        });
    }

    settle(token: IIntentToken) {
        if (!this.isCurrent(token)) {
            return false;
        }
        this.finish(token.id, 'settled');
        this.pendingTargetPage = null;
        this.active = null;
        return true;
    }

    setAnchor(anchor: ISemanticAnchor) {
        this.anchor = {...anchor};
    }

    setPageTop(page: number, top: number) {
        this.pageTops.set(page, top);
    }

    correctGeometry(pageTops: ReadonlyMap<number, number>, pageHeight: number, viewportHeight: number) {
        this.geometryRevision += 1;
        pageTops.forEach((top, page) => this.pageTops.set(page, top));
        const pageTop = this.pageTops.get(this.anchor.page) ?? 0;
        this.scrollTop = pageTop
            + this.anchor.pageYFraction * pageHeight
            - this.anchor.viewportYFraction * viewportHeight;
        if (this.active) {
            this.active.token.geometryRevision = this.geometryRevision;
        }
    }

    get currentPage() {
        return Array.from(this.pageTops.entries())
            .sort((left, right) => Math.abs(left[1] - this.scrollTop) - Math.abs(right[1] - this.scrollTop))[0]?.[0] ?? 1;
    }

    demandPages(viewport: number[], destination: number[], retention: number[], budgets: [number, number, number]) {
        this.mountedPages.clear();
        const groups = [
            viewport,
            destination,
            retention,
        ];
        groups.forEach((pages, index) => pages.slice(0, budgets[index]).forEach(page => this.mountedPages.add(page)));
    }

    transitionVisual(page: number, generation: number, next: TVisualState, documentId = this.documentId) {
        const previous = this.visuals.get(page);
        if (previous?.documentId !== documentId || previous.generation !== generation) {
            this.visuals.set(page, {
                documentId,
                generation,
                state: next,
            });
            this.visualTransitions.push(`${page}:${generation}:none>${next}`);
            return true;
        }
        if ((previous.state === 'fresh' || previous.state === 'stale') && next === 'skeleton') {
            return false;
        }
        this.visuals.set(page, {
            ...previous,
            state: next,
        });
        this.visualTransitions.push(`${page}:${generation}:${previous.state}>${next}`);
        return true;
    }

    getVisual(page: number) {
        return this.visuals.get(page)?.state ?? 'none';
    }

    bumpDpr() {
        this.renderEpoch += 1;
    }

    fulfillRange(begin: number, end: number, chunks: Uint8Array[]) {
        const expected = end - begin;
        const bytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
        if (bytes !== expected) throw new Error(`Short range: expected ${expected}, received ${bytes}`);
        this.exactRangeDeliveries.push({
            begin,
            end,
            bytes,
        });
    }

    startOptionalWork() {
        if (![...this.visuals.values()].some(visual => visual.state === 'fresh')) {
            throw new Error('Optional work cannot precede the first stable visual');
        }
        this.optionalWorkStarted = true;
    }

    private isCurrent(token: IIntentToken) {
        return this.active?.token.id === token.id
            && !this.active.controller.signal.aborted
            && token.documentRevision === this.documentRevision
            && token.geometryRevision === this.geometryRevision
            && token.interactionEpoch === this.interactionEpoch;
    }

    private finish(id: string, outcome: 'cancelled' | 'settled') {
        if (!this.terminalOutcomes.has(id)) this.terminalOutcomes.set(id, outcome);
    }
}
