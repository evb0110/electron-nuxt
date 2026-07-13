import {
    describe,
    expect,
    it,
} from 'vitest';
import { cast } from '@tests/helpers/cast';
import { createPdfViewportWritePort } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';

describe('PDF viewport write port ownership tags', () => {
    it('consumes an authority-authored scroll burst and rejects drift as user input', () => {
        const container = cast<HTMLElement>({
            scrollLeft: 0,
            scrollTop: 0,
        });
        const port = createPdfViewportWritePort();
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
    });
});
