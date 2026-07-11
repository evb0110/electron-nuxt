import type {IAnnotationMarkerRect} from '@app/types/annotations';

export type TPdfNavigationTarget =
    | {
        kind: 'page';
        page: number
    }
    | {
        kind: 'rect';
        page: number;
        rect: IAnnotationMarkerRect
    }
    | {
        kind: 'text-anchor';
        page: number;
        text: string;
        prefix?: string;
        suffix?: string
    }
    | {
        kind: 'named-dest';
        destination: string | unknown[]
    };

export interface IPdfNavigationRequest {
    target: TPdfNavigationTarget;
    alignment: 'page-top' | 'rect-center' | 'keep-visible';
    readiness: 'metrics' | 'page-canvas' | 'text-layer' | 'annotation-editor';
    postArrival?: 'search-highlight' | 'annotation-pulse' | 'flash';
    source: 'toolbar' | 'wheel' | 'search' | 'bookmark' | 'annotation' | 'thumbnail' | 'activation' | 'restore';
    supersession: 'latest-wins';
}

export function createPageNavigationRequest(
    page: number,
    source: IPdfNavigationRequest['source'],
): IPdfNavigationRequest {
    return {
        target: {
            kind: 'page',
            page,
        },
        alignment: 'page-top',
        readiness: 'page-canvas',
        source,
        supersession: 'latest-wins',
    };
}
