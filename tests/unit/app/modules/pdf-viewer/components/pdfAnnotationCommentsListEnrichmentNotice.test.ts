// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import type {
    IAnnotationCommentSummary,
    TAnnotationCommentsStatus,
} from '@app/types/annotations';
import type { IAnnotationEnrichmentState } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';
import {
    ENRICHED_ENRICHMENT_STATE,
    ENRICHMENT_NOTICE_SELECTOR,
    ENRICHMENT_RETRY_SELECTOR,
    PENDING_ENRICHMENT_STATE,
    failedEnrichment,
    mountEnrichmentHost,
    resolveEnrichmentState,
    skippedEnrichment,
} from '@tests/helpers/annotationEnrichmentNoticeHarness';
import type { TEnrichmentStateSource } from '@tests/helpers/annotationEnrichmentNoticeHarness';
import PdfAnnotationCommentsList from '@app/modules/pdf-viewer/components/PdfAnnotationCommentsList.vue';

const SIZE_TEXT = 'annotations.enrichmentSkippedSize';
const SOURCE_TEXT = 'annotations.enrichmentSkippedSource';
const FAILED_TEXT = 'annotations.enrichmentFailed';
const RETRY_TEXT = 'annotations.enrichmentRetry';
const UNKNOWN_AUTHOR_TEXT = 'annotations.unknownAuthor';

let unmountList: (() => void) | null = null;

afterEach(() => {
    unmountList?.();
    unmountList = null;
});

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: 'ann-1',
        stableKey: 'ann:0:ann-1',
        pageIndex: 0,
        pageNumber: 1,
        text: 'A highlighted passage',
        kindLabel: 'Highlight',
        subtype: 'Highlight',
        author: null,
        modifiedAt: 1_700_000_000_000,
        color: null,
        uid: null,
        annotationId: 'ann-1',
        source: 'pdf',
        hasNote: false,
        markerRect: null,
        ...overrides,
    };
}

async function mountList(options: {
    comments?: IAnnotationCommentSummary[];
    enrichmentState?: TEnrichmentStateSource;
    status?: TAnnotationCommentsStatus;
    authorName?: string | null;
    onRetryEnrichment?: () => void;
} = {}) {
    const enrichmentState = options.enrichmentState ?? PENDING_ENRICHMENT_STATE;
    const {
        host,
        unmount,
    } = await mountEnrichmentHost(PdfAnnotationCommentsList, () => ({
        comments: options.comments ?? [],
        status: options.status ?? 'ready',
        enrichmentState: resolveEnrichmentState(enrichmentState),
        authorName: options.authorName ?? null,
        ...(options.onRetryEnrichment ? {onRetryEnrichment: options.onRetryEnrichment} : {}),
    }));
    unmountList = unmount;
    return host;
}

describe('PdfAnnotationCommentsList enrichment notice', () => {
    it.each([
        {
            label: 'pending',
            enrichmentState: PENDING_ENRICHMENT_STATE,
        },
        {
            label: 'enriched',
            enrichmentState: ENRICHED_ENRICHMENT_STATE,
        },
    ])('shows nothing new when enrichment is $label', async ({ enrichmentState }) => {
        const host = await mountList({
            comments: [createComment()],
            enrichmentState,
        });

        expect(host.querySelector(ENRICHMENT_NOTICE_SELECTOR)).toBeNull();
    });

    it('shows one accessible notice when enrichment was skipped over limits', async () => {
        const host = await mountList({
            comments: [
                createComment(),
                createComment({
                    id: 'ann-2',
                    stableKey: 'ann:0:ann-2',
                    annotationId: 'ann-2',
                    pageNumber: 2,
                }),
                createComment({
                    id: 'ann-3',
                    stableKey: 'ann:0:ann-3',
                    annotationId: 'ann-3',
                    pageNumber: 3,
                }),
            ],
            enrichmentState: skippedEnrichment('over-byte-limit', false),
        });

        const notices = host.querySelectorAll(ENRICHMENT_NOTICE_SELECTOR);

        // One panel-level line for the whole document, not one per annotation.
        expect(notices).toHaveLength(1);
        expect(notices[0]?.getAttribute('role')).toBe('status');
        expect(notices[0]?.textContent).toContain(SIZE_TEXT);
        expect(host.querySelectorAll('.note-item').length).toBeGreaterThan(1);
    });

    it('appears for a skipped document that has no annotations at all', async () => {
        const host = await mountList({enrichmentState: skippedEnrichment('over-byte-limit', false)});

        expect(host.querySelectorAll(ENRICHMENT_NOTICE_SELECTOR)).toHaveLength(1);
    });

    it.each([
        {
            reason: 'over-byte-limit',
            expected: SIZE_TEXT,
            absent: SOURCE_TEXT,
        },
        {
            reason: 'over-page-count',
            expected: SIZE_TEXT,
            absent: SOURCE_TEXT,
        },
        {
            reason: 'unreadable-source',
            expected: SOURCE_TEXT,
            absent: SIZE_TEXT,
        },
    ] as const)('describes a $reason skip without claiming the wrong cause', async ({
        reason,
        expected,
        absent,
    }) => {
        const host = await mountList({
            comments: [createComment()],
            enrichmentState: skippedEnrichment(reason, true),
        });

        const notice = host.querySelector(ENRICHMENT_NOTICE_SELECTOR);

        expect(notice?.textContent).toContain(expected);
        expect(notice?.textContent).not.toContain(absent);
    });

    it('keeps the notice up for a skip that can still be retried', async () => {
        const host = await mountList({
            comments: [createComment()],
            enrichmentState: skippedEnrichment('over-page-count', true),
        });

        // Retryability is not completeness: the annotations on screen stay
        // incomplete until the retry succeeds.
        expect(host.querySelector(ENRICHMENT_NOTICE_SELECTOR)).not.toBeNull();
        expect(host.querySelector(ENRICHMENT_RETRY_SELECTOR)?.textContent).toContain(RETRY_TEXT);
    });

    it('offers no retry for a skip nothing can fix', async () => {
        const host = await mountList({
            comments: [createComment()],
            enrichmentState: skippedEnrichment('over-byte-limit', false),
        });

        expect(host.querySelector(ENRICHMENT_NOTICE_SELECTOR)).not.toBeNull();
        expect(host.querySelector(ENRICHMENT_RETRY_SELECTOR)).toBeNull();
    });

    it('surfaces a failed enrichment separately from a skip', async () => {
        const host = await mountList({
            comments: [createComment()],
            enrichmentState: failedEnrichment(true),
        });

        const notice = host.querySelector(ENRICHMENT_NOTICE_SELECTOR);

        expect(notice?.getAttribute('role')).toBe('status');
        expect(notice?.textContent).toContain(FAILED_TEXT);
        expect(notice?.textContent).not.toContain(SIZE_TEXT);
        expect(notice?.textContent).not.toContain(SOURCE_TEXT);
        expect(host.querySelector(ENRICHMENT_RETRY_SELECTOR)).not.toBeNull();
    });

    it('drops the retry when a failed read cannot be attempted again', async () => {
        const host = await mountList({enrichmentState: failedEnrichment(false)});

        expect(host.querySelector(ENRICHMENT_NOTICE_SELECTOR)?.textContent).toContain(FAILED_TEXT);
        expect(host.querySelector(ENRICHMENT_RETRY_SELECTOR)).toBeNull();
    });

    it('asks the host to retry enrichment when the notice action is used', async () => {
        const onRetryEnrichment = vi.fn();
        const host = await mountList({
            comments: [createComment()],
            enrichmentState: skippedEnrichment('unreadable-source', true),
            onRetryEnrichment,
        });

        host.querySelector<HTMLButtonElement>(ENRICHMENT_RETRY_SELECTOR)?.click();

        expect(onRetryEnrichment).toHaveBeenCalledOnce();
    });

    it('keeps enriched and genuinely unknown authors unchanged while it shows', async () => {
        const host = await mountList({
            comments: [
                createComment({
                    id: 'named',
                    stableKey: 'ann:0:named',
                    annotationId: 'named',
                    author: 'Ada Lovelace',
                }),
                createComment({
                    id: 'anonymous',
                    stableKey: 'ann:0:anonymous',
                    annotationId: 'anonymous',
                    pageNumber: 2,
                    author: null,
                }),
            ],
            enrichmentState: skippedEnrichment('over-byte-limit', false),
        });

        const authorLabels = Array.from(host.querySelectorAll('.note-item-meta'))
            .map(meta => meta.textContent ?? '');

        expect(authorLabels.some(label => label.includes('Ada Lovelace'))).toBe(true);
        expect(authorLabels.some(label => label.includes(UNKNOWN_AUTHOR_TEXT))).toBe(true);
    });

    it('reacts to the enrichment state changing after mount', async () => {
        const enrichmentState = ref<IAnnotationEnrichmentState>(PENDING_ENRICHMENT_STATE);
        const host = await mountList({
            comments: [createComment()],
            enrichmentState,
        });

        expect(host.querySelector(ENRICHMENT_NOTICE_SELECTOR)).toBeNull();

        enrichmentState.value = skippedEnrichment('over-byte-limit', false);
        await nextTick();

        expect(host.querySelector(ENRICHMENT_NOTICE_SELECTOR)).not.toBeNull();

        enrichmentState.value = ENRICHED_ENRICHMENT_STATE;
        await nextTick();

        expect(host.querySelector(ENRICHMENT_NOTICE_SELECTOR)).toBeNull();
    });
});
