// @vitest-environment happy-dom

import {
    createApp,
    defineComponent,
    h,
    nextTick,
    ref,
} from 'vue';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import { useCombinePdfOperation } from '@app/modules/combine/useCombinePdfOperation';
import { useCombinePdfQueue } from '@app/modules/combine/useCombinePdfQueue';

const mocks = vi.hoisted(() => ({
    combinePdfFiles: vi.fn(),
    savePdfAs: vi.fn(),
}));

vi.mock('@app/services/pdf/combinePdfFiles', () => ({
    CombinePdfError: class CombinePdfError extends Error {
        public constructor(public readonly code: string) {
            super(`PDF combine failed (${code})`);
        }
    },
    combinePdfFiles: mocks.combinePdfFiles,
}));
vi.mock('@app/utils/platformDocuments', () => ({getDocumentFilesCapability: () => ({ savePdfAs: mocks.savePdfAs })}));

interface IQueueFile {
    id: string;
    file: File;
    name: string;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {
        promise,
        resolve,
    };
}

async function flushUpdates() {
    await Promise.resolve();
    await nextTick();
    await Promise.resolve();
    await nextTick();
}

function createQueueFile(id: string): IQueueFile {
    const file = new File([new Uint8Array([1])], `${id}.pdf`, { type: 'application/pdf' });
    return {
        id,
        file,
        name: file.name,
    };
}

async function mountCombinePageStateMachine(openResult: (result: TOpenFileResult) => Promise<boolean>) {
    const host = document.createElement('div');
    document.body.append(host);
    const Harness = defineComponent({setup() {
        const files = ref<IQueueFile[]>([
            createQueueFile('first'),
            createQueueFile('second'),
        ]);
        const operation = useCombinePdfOperation({
            files,
            openResult,
            emitOpenResult: () => undefined,
            translate: key => key,
        });
        const queue = useCombinePdfQueue({
            files,
            isMutationLocked: operation.queueMutationLocked,
            isSupported: () => true,
            toQueueItem: file => ({
                id: file.name,
                file,
                name: file.name,
            }),
        });

        return () => h('section', { class: 'combine-page-state-machine' }, [
            h('ol', files.value.map(item => h('li', {
                class: 'queue-row',
                key: item.id,
            }, item.name))),
            h('button', {
                class: 'remove',
                disabled: operation.queueMutationLocked.value,
                onClick: () => queue.removeFile(0),
            }, 'Remove'),
            h('button', {
                class: 'clear',
                disabled: operation.queueMutationLocked.value,
                onClick: queue.clearFiles,
            }, 'Clear'),
            operation.pendingCombinedResult.value && !operation.isCombining.value
                ? h('button', {
                    class: 'save-as',
                    onClick: operation.savePendingAs,
                }, 'Save As')
                : null,
            h('button', {
                class: 'combine',
                onClick: operation.combine,
            }, operation.pendingCombinedResult.value ? 'Retry' : 'Combine'),
            operation.combineError.value
                ? h('output', { class: 'error' }, operation.combineError.value)
                : null,
        ]);
    }});
    const app = createApp(Harness);
    app.mount(host);
    await nextTick();
    return {
        host,
        unmount() {
            app.unmount();
            host.remove();
        },
    };
}

describe('mounted Combine PDF page state machine', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.savePdfAs.mockResolvedValue('/tmp/saved.pdf');
    });

    it('locks queue mutations, retains a failed-open result, then saves or retries without recombining', async () => {
        const combined = deferred<TOpenFileResult>();
        const result: TOpenFileResult = {
            kind: 'pdf',
            workingPath: '/tmp/combined-working.pdf',
            originalPath: '/tmp/combined-working.pdf',
            isGenerated: true,
        };
        mocks.combinePdfFiles.mockReturnValueOnce(combined.promise);
        const openResult = vi.fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const page = await mountCombinePageStateMachine(openResult);

        (page.host.querySelector('.combine') as HTMLButtonElement).click();
        await nextTick();
        expect(page.host.querySelectorAll('.queue-row')).toHaveLength(2);
        expect((page.host.querySelector('.clear') as HTMLButtonElement).disabled).toBe(true);
        expect((page.host.querySelector('.remove') as HTMLButtonElement).disabled).toBe(true);

        (page.host.querySelector('.clear') as HTMLButtonElement).click();
        (page.host.querySelector('.remove') as HTMLButtonElement).click();
        expect(page.host.querySelectorAll('.queue-row')).toHaveLength(2);

        combined.resolve(result);
        await flushUpdates();
        expect(openResult).toHaveBeenCalledTimes(1);
        expect(page.host.querySelectorAll('.queue-row')).toHaveLength(2);
        expect(page.host.querySelector('.combine')?.textContent).toBe('Retry');
        expect(page.host.querySelector('.save-as')).not.toBeNull();
        expect((page.host.querySelector('.clear') as HTMLButtonElement).disabled).toBe(true);
        expect((page.host.querySelector('.remove') as HTMLButtonElement).disabled).toBe(true);

        (page.host.querySelector('.clear') as HTMLButtonElement).click();
        (page.host.querySelector('.remove') as HTMLButtonElement).click();
        expect(page.host.querySelectorAll('.queue-row')).toHaveLength(2);

        (page.host.querySelector('.save-as') as HTMLButtonElement).click();
        await flushUpdates();
        expect(mocks.savePdfAs).toHaveBeenCalledWith('/tmp/combined-working.pdf', undefined);

        (page.host.querySelector('.combine') as HTMLButtonElement).click();
        await flushUpdates();
        expect(openResult).toHaveBeenCalledTimes(2);
        expect(mocks.combinePdfFiles).toHaveBeenCalledTimes(1);
        expect(page.host.querySelectorAll('.queue-row')).toHaveLength(0);
        expect(page.host.querySelector('.save-as')).toBeNull();

        page.unmount();
    });
});
