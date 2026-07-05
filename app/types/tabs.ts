import type { ITabMetadataCore } from '@contracts/windowTabs';

export interface ITab extends ITabMetadataCore {id: string;}

export type TTabUpdate = Partial<Pick<ITab, 'fileName' | 'originalPath' | 'documentInstanceId' | 'isDirty' | 'isDjvu'>>;
