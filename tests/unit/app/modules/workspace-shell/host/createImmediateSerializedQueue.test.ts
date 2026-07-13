import {
    describe,
    expect,
    it,
} from 'vitest';
import { createImmediateSerializedQueue } from '@app/modules/workspace-shell/host/createImmediateSerializedQueue';

describe('createImmediateSerializedQueue', () => {
    it('starts an idle command synchronously and serializes later commands', async () => {
        const enqueue = createImmediateSerializedQueue();
        const firstGate = Promise.withResolvers<undefined>();
        const events: string[] = [];

        const first = enqueue(async () => {
            events.push('first-start');
            await firstGate.promise;
            events.push('first-end');
        });
        const second = enqueue(async () => {
            events.push('second-start');
        });

        expect(events).toEqual(['first-start']);
        firstGate.resolve(undefined);
        await Promise.all([
            first,
            second,
        ]);
        expect(events).toEqual([
            'first-start',
            'first-end',
            'second-start',
        ]);
    });
});
