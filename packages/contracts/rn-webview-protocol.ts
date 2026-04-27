import type { TDocumentRef } from './document';
import type {
    IReaderCommandRequest,
    IReaderCommandState,
} from './reader-commands';
import type { IViewerHostEnvironment } from './viewer-host';

export type TViewerBridgeTheme = 'light' | 'dark' | 'system';
export type TViewerBridgeLayoutMode = 'desktop' | 'mobile';

export interface IRnWebViewDocumentOpenPayload {
    documentId: string;
    ref: TDocumentRef;
    suggestedName?: string;
    mimeType?: string;
    size?: number;
    base64?: string;
}

export type THostToViewerMessage =
    | {
        type: 'host:environment';
        environment: IViewerHostEnvironment;
    }
    | {
        type: 'host:ping';
        requestId: string;
    }
    | ({ type: 'document:open'; } & IRnWebViewDocumentOpenPayload)
    | ({type: 'document:open-ranged';} & Omit<IRnWebViewDocumentOpenPayload, 'base64'>)
    | ({
        type: 'document:open-chunked';
        chunkCount: number;
    } & Omit<IRnWebViewDocumentOpenPayload, 'base64'>)
    | {
        type: 'document:chunk';
        documentId: string;
        index: number;
        base64: string;
    }
    | {
        type: 'document:bytes';
        requestId: string;
        base64: string;
    }
    | {
        type: 'document:range';
        requestId: string;
        offset: number;
        base64: string;
        eof?: boolean;
        error?: string;
    }
    | {
        type: 'reader:go-to-page';
        page: number;
    }
    | {
        type: 'reader:execute-command';
        command: IReaderCommandRequest;
    }
    | {
        type: 'reader:set-theme';
        theme: TViewerBridgeTheme;
    }
    | {
        type: 'reader:set-layout-mode';
        mode: TViewerBridgeLayoutMode;
    }
    | {
        type: 'search:run';
        query: string;
    }
    | {
        type: 'search:cancel';
        requestId?: string;
    };

export type TViewerToHostMessage =
    | { type: 'viewer:ready'; }
    | {
        type: 'document:loaded';
        documentId: string | null;
        pageCount: number;
        title?: string;
    }
    | {type: 'document:request-open';}
    | {
        type: 'document:request-bytes';
        requestId: string;
        ref: TDocumentRef;
    }
    | {
        type: 'document:request-range';
        requestId: string;
        ref: TDocumentRef;
        offset: number;
        length: number;
    }
    | {
        type: 'reader:page-changed';
        page: number;
        pageCount: number;
    }
    | {
        type: 'document:chunk-ack';
        documentId: string;
        index: number;
        receivedCount: number;
        chunkCount: number;
    }
    | {
        type: 'document:open-started';
        documentId: string;
        title?: string;
    }
    | {
        type: 'reader:viewport-state';
        page: number;
        zoom: number;
    }
    | {
        type: 'reader:commands-changed';
        commands: IReaderCommandState[];
    }
    | {
        type: 'search:progress';
        requestId: string;
        processed: number;
        total: number;
    }
    | {
        type: 'search:results';
        requestId: string;
        count: number;
    }
    | {
        type: 'document:request-share';
        documentId: string;
        suggestedName: string;
        bytesRef?: string;
    }
    | {
        type: 'shell:open-external';
        url: string;
    }
    | {
        type: 'viewer:error';
        code: string;
        message: string;
    };
