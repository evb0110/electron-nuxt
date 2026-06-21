import { ref } from 'vue';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfAnnotationCommentModel } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationCommentModel';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';

function markerRect(overrides: Partial<IAnnotationMarkerRect> = {}): IAnnotationMarkerRect {
    return {
        left: 0.1,
        top: 0.2,
        width: 0.3,
        height: 0.04,
        ...overrides,
    };
}

function comment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: overrides.id ?? 'comment-1',
        stableKey: overrides.stableKey ?? 'stable-1',
        pageIndex: overrides.pageIndex ?? 0,
        pageNumber: overrides.pageNumber ?? 1,
        text: overrides.text ?? 'note',
        author: overrides.author ?? null,
        modifiedAt: overrides.modifiedAt ?? null,
        color: overrides.color ?? null,
        uid: overrides.uid ?? null,
        annotationId: overrides.annotationId ?? 'annotation-1',
        source: overrides.source ?? 'pdf',
        hasNote: overrides.hasNote ?? true,
        markerRect: overrides.markerRect ?? markerRect(),
        ...overrides,
    };
}

function createModel() {
    const emitted: IAnnotationCommentSummary[][] = [];
    const suppressAnnotationStableKey = vi.fn();
    const unsuppressAnnotationStableKey = vi.fn();
    const suppressAnnotationId = vi.fn();
    const unsuppressAnnotationId = vi.fn();
    const model = usePdfAnnotationCommentModel({
        isAnySaving: ref(false),
        getShapeAnnotationCommentSummaries: () => [],
        emitAnnotationComments: comments => emitted.push(comments),
        suppressAnnotationStableKey,
        unsuppressAnnotationStableKey,
        suppressAnnotationId,
        unsuppressAnnotationId,
    });
    return {
        emitted,
        model,
        suppressAnnotationId,
        suppressAnnotationStableKey,
        unsuppressAnnotationId,
        unsuppressAnnotationStableKey,
    };
}

describe('usePdfAnnotationCommentModel', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-27T00:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('preserves text markup display text through reload grace', () => {
        const { model } = createModel();
        model.handleSourceChanged('next.pdf', 'previous.pdf');
        model.upsertComment(comment({
            annotationId: 'old-highlight',
            displayText: 'selected text',
            hasNote: false,
            stableKey: 'old-stable',
            subtype: 'highlight',
            text: '',
        }));

        const merged = model.applyFromSync([comment({
            annotationId: 'new-highlight',
            displayText: null,
            hasNote: false,
            id: 'comment-2',
            stableKey: 'new-stable',
            subtype: 'highlight',
            text: '',
            markerRect: markerRect({ left: 0.105 }),
        })]);

        expect(merged).toHaveLength(1);
        expect(merged[0]?.displayText).toBe('selected text');
    });

    it('updates cached text markup color through normalized annotation ids', () => {
        const { model } = createModel();
        const cached = comment({
            annotationId: '42R',
            color: '#ef4444',
            subtype: 'Underline',
        });
        model.upsertComment(cached);

        model.updateCachedColor(comment({
            ...cached,
            annotationId: '42R0',
        }), '#3b82f6');

        expect(model.annotationCommentsCache.value[0]).toMatchObject({
            annotationId: '42R',
            color: '#3b82f6',
            colorEdited: true,
        });
    });

    it('preserves edited text markup color through normalized ids during sync', () => {
        const { model } = createModel();
        model.upsertComment(comment({
            annotationId: '42R0',
            color: '#3b82f6',
            colorEdited: true,
            subtype: 'StrikeOut',
        }));

        const merged = model.applyFromSync([comment({
            annotationId: '42R',
            color: '#ef4444',
            subtype: 'StrikeOut',
        })]);

        expect(merged[0]).toMatchObject({
            annotationId: '42R',
            color: '#3b82f6',
            colorEdited: true,
        });
    });

    it('suppresses locally deleted comments that reappear from sync', () => {
        const {
            model,
            suppressAnnotationId,
            suppressAnnotationStableKey,
        } = createModel();
        const deleted = comment();

        model.upsertComment(deleted);
        model.markLocallyDeleted(deleted);
        const merged = model.applyFromSync([deleted]);

        expect(merged).toEqual([]);
        expect(model.annotationCommentsCache.value).toEqual([]);
        expect(suppressAnnotationStableKey).toHaveBeenCalledWith('stable-1');
        expect(suppressAnnotationId).toHaveBeenCalledWith('annotation-1');
    });

    it('restores local deletion and unsuppresses identifiers', () => {
        const {
            model,
            unsuppressAnnotationId,
            unsuppressAnnotationStableKey,
        } = createModel();
        const restored = comment();

        model.markLocallyDeleted(restored);
        model.restoreLocally(restored);

        expect(model.annotationCommentsCache.value).toHaveLength(1);
        expect(unsuppressAnnotationStableKey).toHaveBeenCalledWith('stable-1');
        expect(unsuppressAnnotationId).toHaveBeenCalledWith('annotation-1');
    });

    it('updates cache, pending marker move, and editor pending state when a marker moves', () => {
        const { model } = createModel();
        const original = comment();
        const editor = {};
        const markModified = vi.fn();
        const movedRect = markerRect({ left: 0.5 });

        model.upsertComment(original);
        const moved = model.handleMarkerMove(original, movedRect, {
            markEditorPending: (updated, previous, rect) => {
                expect(previous).toBe(original);
                expect(rect).toBe(movedRect);
                Object.assign(editor, {
                    __evbPendingAnchorRect: rect,
                    stableKey: updated.stableKey,
                });
            },
            markModified,
        });

        expect(moved).toBe(true);
        expect(model.annotationCommentsCache.value[0]?.markerRect).toEqual(movedRect);
        expect(model.pendingMarkerMoves.get('stable-1')?.markerRect).toEqual(movedRect);
        expect(editor).toMatchObject({
            __evbPendingAnchorRect: movedRect,
            stableKey: 'stable-1',
        });
        expect(markModified).toHaveBeenCalledTimes(1);
    });

    it('returns cloned marker rects in snapshots', () => {
        const { model } = createModel();
        model.upsertComment(comment());

        const snapshot = model.getSnapshot();
        snapshot[0]!.markerRect!.left = 9;

        expect(model.annotationCommentsCache.value[0]?.markerRect?.left).toBe(0.1);
    });

    it('clears transient reload state when source becomes empty', () => {
        const {
            emitted,
            model,
        } = createModel();
        model.upsertComment(comment());

        model.handleSourceChanged(null, 'previous.pdf');

        expect(model.annotationCommentsCache.value).toEqual([]);
        expect(emitted.at(-1)).toEqual([]);
    });

    it('replaces the annotation reload grace timer on source changes', () => {
        const { model } = createModel();
        const syncAnnotationComments = vi.fn();

        model.handleSourceChanged('second.pdf', 'first.pdf', { syncAnnotationComments });
        model.handleSourceChanged('third.pdf', 'second.pdf', { syncAnnotationComments });
        vi.advanceTimersByTime(5_101);

        expect(syncAnnotationComments).toHaveBeenCalledOnce();
    });
});
