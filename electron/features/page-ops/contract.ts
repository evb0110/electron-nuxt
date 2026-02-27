export const PAGE_OPS_CHANNELS = {
    delete: 'page-ops:delete',
    extract: 'page-ops:extract',
    reorder: 'page-ops:reorder',
    insert: 'page-ops:insert',
    insertFile: 'page-ops:insert-file',
    rotate: 'page-ops:rotate',
} as const;

type TPageOpsRotationAngle = 90 | 180 | 270;

interface IPageOpsResult {
    success: boolean;
    pageCount?: number;
}

interface IPageOpsExtractResult {
    success: boolean;
    canceled?: boolean;
    destPath?: string;
}

interface IPageOpsInsertResult {
    success: boolean;
    canceled?: boolean;
}

interface IPageOpsCapability {
    delete: (workingCopyPath: string, pages: number[], totalPages: number) => Promise<IPageOpsResult>;
    extract: (workingCopyPath: string, pages: number[]) => Promise<IPageOpsExtractResult>;
    reorder: (workingCopyPath: string, newOrder: number[]) => Promise<IPageOpsResult>;
    insert: (workingCopyPath: string, totalPages: number, afterPage: number) => Promise<IPageOpsInsertResult>;
    insertFile: (workingCopyPath: string, totalPages: number, afterPage: number, sourcePaths: string[]) => Promise<IPageOpsResult>;
    rotate: (workingCopyPath: string, pages: number[], angle: TPageOpsRotationAngle) => Promise<IPageOpsResult>;
}
