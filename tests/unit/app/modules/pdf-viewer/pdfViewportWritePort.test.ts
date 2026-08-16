import {
    describe,
    expect,
    it,
} from 'vitest';
import { cast } from '@tests/helpers/cast';
import { createPdfViewportWritePort } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';
import { createTestPdfViewportWritePort } from '@tests/helpers/createTestPdfViewportWritePort';

describe('PDF viewport write port ownership tags', () => {
    it('consumes an authority-authored scroll burst and rejects drift as user input', () => {
        const container = cast<HTMLElement>({
            scrollLeft: 0,
            scrollTop: 0,
        });
        const port = createPdfViewportWritePort();
        expect(port.getInteractionEpoch()).toBe(0);
        const firstIntent = port.beginIntent('navigation-1');
        port.apply(container, {
            intent: firstIntent,
            reason: 'test',
            top: 120,
        });
        expect(port.consumeAuthorityScroll(container)).toBe(true);
        expect(port.consumeAuthorityScroll(container)).toBe(true);

        const secondIntent = port.beginIntent('navigation-2');
        port.apply(container, {
            intent: secondIntent,
            reason: 'test',
            top: 180,
        });
        container.scrollTop = 181;
        expect(port.consumeAuthorityScroll(container)).toBe(false);
        port.observeUserScroll(container);
        expect(port.getInteractionEpoch()).toBe(1);

        const preWheelIntent = port.beginIntent('pre-wheel-layout-restore');
        port.observeUserInteraction();
        expect(port.getInteractionEpoch()).toBe(2);
        expect(port.apply(container, {
            intent: preWheelIntent,
            reason: 'stale-after-wheel',
            top: 220,
        })).toBe(false);
    });
});

describe('shared test PDF viewport write port', () => {
    it('models user interaction superseding an existing intent', () => {
        const {port} = createTestPdfViewportWritePort();
        const beforeInteraction = port.beginIntent('before-interaction');

        port.observeUserInteraction();

        expect(port.getInteractionEpoch()).toBe(1);
        expect(beforeInteraction.interactionEpoch).toBe(0);
        expect(port.beginIntent('after-interaction').interactionEpoch).toBe(1);
    });
});
