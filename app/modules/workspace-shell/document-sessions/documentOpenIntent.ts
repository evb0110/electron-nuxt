import type { TTabUpdate } from '@app/types/tabs';
import type { TWorkspaceCommandTarget } from '@app/modules/workspace-shell/document-sessions/workspaceCommandTarget';

export interface IDocumentOpenIntent {
    action: string;
    commandTarget?: TWorkspaceCommandTarget | undefined;
    target?: TTabUpdate | null;
}
