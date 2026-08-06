// @vitest-environment happy-dom

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    ref,
} from 'vue';
import {useScanCleanupSourceSha256} from '@app/modules/scan-cleanup/composables/useScanCleanupSourceSha256';

const files = vi.hoisted(() => ({
    createManagedTempFileHandle: vi.fn(),
    releaseManagedTempFileHandle: vi.fn(),
}));

vi.mock('@app/utils/platform', () => ({isDesktopPlatformActive: () => true}));
vi.mock('@app/utils/platformDocuments', () => ({getDocumentFilesCapability: () => files}));

describe('scan cleanup source SHA-256 bridge', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        files.createManagedTempFileHandle.mockResolvedValue({
            path: '/working/book.pdf',
            size: 1,
            sha256: 'A'.repeat(64),
            leaseId: 'scan-cleanup-hash-lease',
            revision: null,
        });
        files.releaseManagedTempFileHandle.mockResolvedValue(true);
    });

    it('uses the main-owned managed-file hash and releases its lease', async () => {
        const enabled = ref(true);
        const sourcePath = ref('/working/book.pdf');
        const documentRevision = ref('revision-1');
        let sourceSha256: ReturnType<typeof useScanCleanupSourceSha256> | null = null;
        const host = document.createElement('div');
        const app = createApp(defineComponent({setup() {
            sourceSha256 = useScanCleanupSourceSha256({
                enabled,
                sourcePath,
                documentRevision,
            });
            return () => h('div');
        }}));
        app.mount(host);

        await vi.waitFor(() => expect(sourceSha256?.value).toBe('a'.repeat(64)));
        expect(files.createManagedTempFileHandle).toHaveBeenCalledWith('/working/book.pdf');
        expect(files.releaseManagedTempFileHandle).toHaveBeenCalledWith('scan-cleanup-hash-lease');

        app.unmount();
        host.remove();
    });

    it('retains an acquired hash while disabled and does not reacquire the same document', async () => {
        const enabled = ref(true);
        const sourcePath = ref('/working/book.pdf');
        const documentRevision = ref('revision-1');
        let sourceSha256: ReturnType<typeof useScanCleanupSourceSha256> | null = null;
        const host = document.createElement('div');
        const app = createApp(defineComponent({setup() {
            sourceSha256 = useScanCleanupSourceSha256({
                enabled,
                sourcePath,
                documentRevision,
            });
            return () => h('div');
        }}));
        app.mount(host);

        await vi.waitFor(() => expect(sourceSha256?.value).toBe('a'.repeat(64)));
        enabled.value = false;
        await vi.waitFor(() => expect(sourceSha256?.value).toBe('a'.repeat(64)));
        enabled.value = true;
        await vi.waitFor(() => expect(sourceSha256?.value).toBe('a'.repeat(64)));
        expect(files.createManagedTempFileHandle).toHaveBeenCalledOnce();

        app.unmount();
        host.remove();
    });
});
