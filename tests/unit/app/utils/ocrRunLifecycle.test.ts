import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createOcrRunLifecycle,
    OcrRunCanceledError,
} from '@app/utils/ocr/ocrRunLifecycle';
import {requireRequestId} from '@contracts/shared';

describe('ocrRunLifecycle', () => {
    it('invalidates stale run guards when canceling or starting a later generation', () => {
        const lifecycle = createOcrRunLifecycle();
        const firstRun = lifecycle.beginRun();
        lifecycle.markRequestActive(requireRequestId('ocr-first'));

        expect(lifecycle.isRunActive(firstRun.runToken, firstRun.runGeneration)).toBe(true);
        expect(lifecycle.cancelActiveRun()).toBe('ocr-first');
        expect(() => firstRun.ensureRunActive()).toThrow(OcrRunCanceledError);

        const secondRun = lifecycle.beginRun();
        expect(lifecycle.isRunActive(secondRun.runToken, secondRun.runGeneration)).toBe(true);
        expect(lifecycle.isRunActive(firstRun.runToken, firstRun.runGeneration)).toBe(false);
    });

    it('keeps late cancel completion watches scoped to the matching request', () => {
        const lifecycle = createOcrRunLifecycle();
        lifecycle.beginRun();
        lifecycle.markRequestActive(requireRequestId('ocr-active'));
        lifecycle.beginCancelingRequest(requireRequestId('ocr-active'));

        expect(lifecycle.getActiveRequestId()).toBe('ocr-active');
        expect(lifecycle.getCancelingRequestId()).toBe('ocr-active');
        expect(lifecycle.shouldHandleLateCanceledResult(requireRequestId('ocr-other'))).toBe(false);
        expect(lifecycle.finishCancelingRequest(requireRequestId('ocr-other'))).toBe(false);
        expect(lifecycle.getActiveRequestId()).toBe('ocr-active');

        expect(lifecycle.shouldHandleLateCanceledResult(requireRequestId('ocr-active'))).toBe(true);
        expect(lifecycle.finishCancelingRequest(requireRequestId('ocr-active'))).toBe(true);
        expect(lifecycle.getActiveRequestId()).toBeNull();
        expect(lifecycle.getCancelingRequestId()).toBeNull();
    });
});
