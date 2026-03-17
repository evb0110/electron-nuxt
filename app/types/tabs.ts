import type { TDocumentRef } from '@contracts/platform-api';

export interface ITab {
    id: string;
    fileName: string | null;
    originalPath: TDocumentRef | null;
    isDirty: boolean;
    isDjvu: boolean;
}

export type TTabUpdate = Partial<Pick<ITab, 'fileName' | 'originalPath' | 'isDirty' | 'isDjvu'>>;
