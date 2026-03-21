export const ANALYTICS_EVENT_NAMES = [
    'viewer_session_started',
    'browser_install_hint_interacted',
    'document_opened',
    'search_executed',
    'viewer_mode_changed',
    'save_completed',
    'page_operation_completed',
    'export_completed',
] as const;

export type TAnalyticsEventName = typeof ANALYTICS_EVENT_NAMES[number];

export type TAnalyticsScreenCategory = 'mobile' | 'tablet' | 'desktop';

export type TAnalyticsPayloadValue =
    | boolean
    | number
    | string
    | null
    | TAnalyticsPayloadValue[]
    | { [key: string]: TAnalyticsPayloadValue };

export interface IAnalyticsDocumentContext {
    documentKind?: 'pdf' | 'djvu';
    fileExtension?: string | null;
    fileSizeBucket?: string | null;
    isGenerated?: boolean;
    pageCountBucket?: string | null;
    totalPages?: number | null;
}

export interface IAnalyticsEventEnvelope {
    name: TAnalyticsEventName;
    occurredAt: string;
    path: string;
    locale: string | null;
    referrer: string | null;
    screenCategory: TAnalyticsScreenCategory;
    sessionId: string;
    payload: Record<string, TAnalyticsPayloadValue>;
}
