import { vi } from 'vitest';
import type {
    IPlatformApi,
    IDocumentsCapability,
    IDocumentsFileIoCapability,
    IDocumentsPickerCapability,
    IDocumentsWorkingCopyCapability,
} from '@contracts/platformApi';
import { ELECTRON_PLATFORM_MANIFEST } from '@contracts/platformApi';
import { cast } from '@tests/helpers/cast';

interface IElectronPlatformApiFixtureOverrides extends Partial<Omit<
    IPlatformApi,
    'documents' | 'documentPicker' | 'documentFiles' | 'documentWorkingCopy'
>> {
    documents?: Partial<IDocumentsCapability>;
    documentFiles?: Partial<IDocumentsFileIoCapability>;
    documentPicker?: Partial<IDocumentsPickerCapability>;
    documentWorkingCopy?: Partial<IDocumentsWorkingCopyCapability>;
}

export function createElectronPlatformApiFixture(
    overrides: IElectronPlatformApiFixtureOverrides = {},
) {
    const {
        documentFiles,
        documentPicker,
        documentWorkingCopy,
        documents,
        ...topLevelOverrides
    } = overrides;

    return cast<IPlatformApi>({
        manifest: ELECTRON_PLATFORM_MANIFEST,
        documents: {
            openDocumentDialog: vi.fn(),
            openDocumentDirect: vi.fn(),
            readFile: vi.fn(),
            registerFilesForOpen: vi.fn(async () => []),
            saveFileStructured: vi.fn(),
            recentFiles: { get: vi.fn() },
            ...documents,
        },
        pageOps: { delete: vi.fn() },
        imageExport: { exportPdfToImages: vi.fn() },
        ocr: { recognize: vi.fn() },
        search: { run: vi.fn() },
        djvu: { openForViewing: vi.fn() },
        settings: { get: vi.fn() },
        system: { getMemoryInfo: vi.fn() },
        updates: { getState: vi.fn() },
        windowTabs: { transfer: vi.fn() },
        shell: { openExternal: vi.fn() },
        host: { getEnvironment: vi.fn() },
        agent: { onWorkspaceSnapshotRequest: vi.fn() },
        ...(documentFiles === undefined ? {} : { documentFiles }),
        ...(documentPicker === undefined ? {} : { documentPicker }),
        ...(documentWorkingCopy === undefined ? {} : { documentWorkingCopy }),
        ...topLevelOverrides,
    });
}
