import {
    describe,
    expect,
    it,
} from 'vitest';
import { createPdfPageSlotRegistry } from '@app/modules/pdf-viewer/runtime/page-slots/pdfPageSlotRegistry';

describe('createPdfPageSlotRegistry', () => {
    it('settles readiness exactly when the requested slot mounts', async () => {
        const slots = createPdfPageSlotRegistry();
        const controller = new AbortController();
        let settled = false;
        const readiness = slots.whenMounted(42, controller.signal).then(() => {
            settled = true;
        });

        slots.markMounted(41);
        await Promise.resolve();
        expect(settled).toBe(false);

        slots.markMounted(42);
        await readiness;
        expect(settled).toBe(true);
        expect(slots.isMounted(42)).toBe(true);
    });

    it('rejects pending readiness when its work is superseded', async () => {
        const slots = createPdfPageSlotRegistry();
        const controller = new AbortController();
        const readiness = slots.whenMounted(9, controller.signal);

        controller.abort();

        await expect(readiness).rejects.toMatchObject({name: 'AbortError'});
    });

    it('resolves immediately for an already mounted slot', async () => {
        const slots = createPdfPageSlotRegistry();
        slots.markMounted(3);

        await expect(slots.whenMounted(3, new AbortController().signal)).resolves.toBeUndefined();
    });

    it('isolates an incoming feature owner from stale outgoing cleanup', async () => {
        const registry = createPdfPageSlotRegistry();
        const outgoing = registry.createOwner('pdf:old');
        const incoming = registry.createOwner('djvu:new');
        const signal = new AbortController().signal;
        const incomingReadiness = incoming.whenMounted(7, signal);

        incoming.markMounted(7);
        outgoing.markMounted(7);
        outgoing.cancelPending();
        outgoing.markUnmounted(7);
        outgoing.dispose();

        await expect(incomingReadiness).resolves.toBeUndefined();
        expect(incoming.isMounted(7)).toBe(true);
        incoming.markUnmounted(7);
        expect(incoming.isMounted(7)).toBe(false);
    });
});
