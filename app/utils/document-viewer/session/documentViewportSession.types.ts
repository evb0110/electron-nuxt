export interface IDocumentViewportIdentity {
    readonly documentId: string;
    readonly revision: string;
}

export type TDocumentViewportLifecycle = 'empty' | 'opening' | 'transitioning'
    | 'ready' | 'closing' | 'failed';

export interface IDocumentViewportRenderFence {
    readonly generation: number;
    readonly revision: string;
    readonly pageNumber: number;
    readonly viewportIntentId: string;
    readonly renderVersion: number;
    readonly requestId: number;
}

export interface IDocumentViewportCommitFence {
    readonly generation: number;
    readonly revision: string;
    readonly pageNumber: number;
    readonly viewportIntentId: string;
    readonly geometryRevision: number;
    readonly interactionEpoch: number;
}

export interface IDocumentViewportIntent {
    readonly generation: number;
    readonly id: string;
    readonly pageNumber: number;
}

export interface IDocumentViewportSkeletonDelay {
    readonly generation: number;
    readonly token: string;
    readonly pageNumber: number;
    readonly deadline: number;
}

export type TDocumentViewportVisualOwner =
    | { readonly kind: 'empty' }
    | {
        readonly kind: 'page';
        readonly generation: number;
        readonly pageNumber: number;
        readonly presentation: 'cold-shell' | 'prepared-shell' | 'skeleton' | 'canvas' | 'error';
        readonly frameKey: string | null;
        readonly error: string | null;
    }
    | {
        readonly kind: 'failed';
        readonly generation: number;
        readonly error: string;
    };

export interface IDocumentViewportSessionState {
    readonly generation: number;
    readonly identity: IDocumentViewportIdentity | null;
    readonly lifecycle: TDocumentViewportLifecycle;
    /** Latest user intent. It is deliberately allowed to exceed an as-yet unknown page count. */
    readonly requestedPage: number;
    readonly committedPage: number | null;
    /** Semantic page currently observed in a settled, freely scrolled viewport. */
    readonly observedPage: number | null;
    readonly pageCount: number | null;
    readonly visual: TDocumentViewportVisualOwner;
    readonly viewportIntent: IDocumentViewportIntent | null;
    readonly renderFence: IDocumentViewportRenderFence | null;
    /** Canvas commit for the active intent; promoted only when its viewport also commits. */
    readonly stagedRenderFence: IDocumentViewportRenderFence | null;
    /** Viewport commit for the active intent; promoted only when its canvas also commits. */
    readonly stagedViewportFence: IDocumentViewportCommitFence | null;
    readonly committedRenderFence: IDocumentViewportRenderFence | null;
    readonly committedViewportFence: IDocumentViewportCommitFence | null;
    readonly skeletonDelay: IDocumentViewportSkeletonDelay | null;
    readonly failure: string | null;
}

export interface IDocumentViewportPreparedPage {
    readonly pageNumber: number;
    readonly pageCount: number;
    readonly frameKey: string;
}

export type TDocumentViewportSessionEvent =
    | {
        readonly type: 'open-requested';
        readonly identity: IDocumentViewportIdentity;
        readonly viewportIntentId: string;
        readonly initialPage?: number;
        readonly preparedPage?: IDocumentViewportPreparedPage;
        readonly skeletonDelay?: {
            readonly token: string;
            readonly deadline: number
        };
    }
    | {
        readonly type: 'identity-refined';
        readonly generation: number;
        readonly identity: IDocumentViewportIdentity;
    }
    | {
        readonly type: 'metadata-ready';
        readonly generation: number;
        readonly pageCount: number
    }
    | {
        readonly type: 'navigation-requested';
        readonly pageNumber: number;
        readonly viewportIntentId: string;
        readonly skeletonDelay?: {
            readonly token: string;
            readonly deadline: number
        };
    }
    | {
        readonly type: 'page-observed';
        readonly generation: number;
        readonly pageNumber: number;
    }
    | {
        readonly type: 'navigation-superseded-by-user';
        readonly generation: number;
        readonly pageNumber: number;
    }
    | {
        readonly type: 'render-started';
        readonly fence: IDocumentViewportRenderFence
    }
    | {
        readonly type: 'canvas-committed';
        readonly fence: IDocumentViewportRenderFence
    }
    | {
        readonly type: 'viewport-committed';
        readonly fence: IDocumentViewportCommitFence
    }
    | {
        readonly type: 'skeleton-delay-elapsed';
        readonly generation: number;
        readonly token: string;
    }
    | {
        readonly type: 'page-failed';
        readonly fence: IDocumentViewportRenderFence;
        readonly error: string
    }
    | {
        readonly type: 'page-transition-failed';
        readonly generation: number;
        readonly pageNumber: number;
        readonly viewportIntentId: string;
        readonly error: string;
    }
    | {
        readonly type: 'open-failed';
        readonly generation: number;
        readonly error: string
    }
    | { readonly type: 'close-requested' }
    | {
        readonly type: 'close-committed';
        readonly generation: number
    };

export type TDocumentViewportSessionEffect = {
    readonly type: 'schedule-skeleton-delay';
    readonly generation: number;
    readonly pageNumber: number;
    readonly token: string;
    readonly deadline: number;
}
    | {
        readonly type: 'cancel-skeleton-delay';
        readonly token: string
    };

export interface IDocumentViewportSessionTransition {
    readonly state: IDocumentViewportSessionState;
    readonly effects: readonly TDocumentViewportSessionEffect[];
    readonly accepted: boolean;
}
