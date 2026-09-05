import type { ITabMetadataCore } from '@contracts/windowTabs';

export interface ITab {
    id: string;
    fileName: ITabMetadataCore['fileName'];
    originalPath: ITabMetadataCore['originalPath'];
    originalBackend?: ITabMetadataCore['originalBackend'];
    documentInstanceId?: ITabMetadataCore['documentInstanceId'];
    isDirty: ITabMetadataCore['isDirty'];
    isDjvu: ITabMetadataCore['isDjvu'];
}

export type TTabUpdate = Partial<Pick<ITab, 'fileName' | 'originalPath' | 'documentInstanceId' | 'isDirty' | 'isDjvu'>>;
