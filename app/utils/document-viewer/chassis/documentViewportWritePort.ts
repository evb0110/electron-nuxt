export interface IDocumentViewportIntentFence {
    readonly intentId: string;
    readonly documentRevision: number;
    readonly interactionEpoch: number;
    readonly sequence: number;
}

export interface IDocumentViewportWrite {
    intent: IDocumentViewportIntentFence;
    reason: string;
    left?: number;
    top?: number;
}

export interface IDocumentViewportWritePort {
    beginIntent(intentId: string): IDocumentViewportIntentFence;
    apply(container: HTMLElement, write: IDocumentViewportWrite): boolean;
    advanceDocumentRevision(): number;
    assertNoRogueWrite(container: HTMLElement): void;
    consumeAuthorityScroll(container: HTMLElement): boolean;
    observeUserScroll(container: HTMLElement): void;
}

/**
 * The sole programmatic viewport writer shared by every document source and
 * rendering feature pack mounted in DocumentViewerChassis.
 */
export function createDocumentViewportWritePort(): IDocumentViewportWritePort {
    let documentRevision = 0;
    let interactionEpoch = 0;
    let sequence = 0;
    let activeIntent: IDocumentViewportIntentFence | null = null;
    const committed = new WeakMap<HTMLElement, {
        left: number;
        top: number;
    }>();
    const authorityWrites = new WeakMap<HTMLElement, {
        intentId: string;
        left: number;
        top: number;
    }>();
    const record = (container: HTMLElement) => committed.set(container, {
        left: container.scrollLeft,
        top: container.scrollTop,
    });

    return {
        beginIntent(intentId) {
            if (!intentId) {
                throw new Error('Viewport intents require an intentId');
            }
            activeIntent = Object.freeze({
                intentId,
                documentRevision,
                interactionEpoch,
                sequence: ++sequence,
            });
            return activeIntent;
        },
        apply(container, write) {
            if (
                write.intent !== activeIntent
                || write.intent.documentRevision !== documentRevision
                || write.intent.interactionEpoch !== interactionEpoch
            ) {
                return false;
            }
            if (write.left !== undefined) container.scrollLeft = write.left;
            if (write.top !== undefined) container.scrollTop = write.top;
            authorityWrites.set(container, {
                intentId: write.intent.intentId,
                left: container.scrollLeft,
                top: container.scrollTop,
            });
            record(container);
            return true;
        },
        advanceDocumentRevision() {
            documentRevision += 1;
            activeIntent = null;
            return documentRevision;
        },
        assertNoRogueWrite(container) {
            const expected = committed.get(container);
            if (expected && (expected.left !== container.scrollLeft || expected.top !== container.scrollTop)) {
                throw new Error('Rogue document viewport write detected outside ViewportAuthority');
            }
        },
        consumeAuthorityScroll(container) {
            const authored = authorityWrites.get(container);
            if (!authored) {
                return false;
            }
            if (authored.left !== container.scrollLeft || authored.top !== container.scrollTop) {
                authorityWrites.delete(container);
                return false;
            }
            authorityWrites.delete(container);
            record(container);
            return true;
        },
        observeUserScroll(container) {
            interactionEpoch += 1;
            activeIntent = null;
            authorityWrites.delete(container);
            record(container);
        },
    };
}
