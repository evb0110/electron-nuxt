import type { IpcMainInvokeEvent } from 'electron';
import {
    app,
    ipcMain,
} from 'electron';
import type { IIpcMainRegistrar as IContractIpcMainRegistrar } from '@contracts/ipcMain';
import {
    SEARCH_CHANNELS,
    type ISearchInvokeMap,
} from '@electron/features/search/contract';
import { createSearchService } from '@electron/features/search/createSearchService';
import { getSearchWorkerServiceConfig } from '@electron/features/search/main/searchWorkerService';
import type { ISearchService } from '@electron/features/search/searchService';
import { createLogger } from '@electron/utils/createLogger';

export type TSearchIpcMainRegistrar = IContractIpcMainRegistrar<ISearchInvokeMap, IpcMainInvokeEvent>;

const log = createLogger('search-ipc');
let appCleanupRegistered = false;

export function registerSearchIpcAdapter(
    registrar: TSearchIpcMainRegistrar = ipcMain,
    service: ISearchService = createSearchService(),
) {
    const serviceConfig = getSearchWorkerServiceConfig();
    log.info(
        'Registering search IPC handlers '
        + `(requestTimeoutMs=${serviceConfig.requestTimeoutMs}, idleTtlMs=${serviceConfig.idleTtlMs}, maxActive=${serviceConfig.maxActive})`,
    );

    registrar.handle(SEARCH_CHANNELS.search, (event, request) =>
        service.search(
            {
                sender: event.sender,
                senderId: event.sender.id,
            },
            request,
        ),
    );
    registrar.handle(SEARCH_CHANNELS.warmIndex, (event, request) =>
        service.warmIndex(
            {
                sender: event.sender,
                senderId: event.sender.id,
            },
            request,
        ),
    );
    registrar.handle(SEARCH_CHANNELS.cancel, (event, requestId?: unknown) =>
        service.cancel(
            {
                sender: event.sender,
                senderId: event.sender.id,
            },
            requestId,
        ),
    );
    registrar.handle(SEARCH_CHANNELS.resetCache, () => service.resetCache());
    registrar.handle(SEARCH_CHANNELS.subscribeProgress, (event) => {
        service.subscribeProgress({
            sender: event.sender,
            senderId: event.sender.id,
        });
        return undefined;
    });

    if (!appCleanupRegistered) {
        appCleanupRegistered = true;
        app.on('before-quit', () => {
            service.cleanupAll('App shutting down');
        });
    }
}
