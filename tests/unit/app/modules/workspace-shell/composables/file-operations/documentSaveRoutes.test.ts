import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolveDocumentSaveRoute,
    type IDocumentSaveRouteConfig,
    type IDocumentSaveRouteContext,
} from '@app/modules/workspace-shell/composables/file-operations/documentSaveRoutes';

const BASE_CONFIG: IDocumentSaveRouteConfig = {
    mode: 'save',
    shouldPreferWorkingCopy: true,
    canPersistNativeWorkingCopy: false,
};

const BASE_CONTEXT: IDocumentSaveRouteContext = {
    workingCopyPath: '/tmp/work.pdf',
    expectedOriginalPath: '/tmp/source.pdf',
    expectedWorkingPath: '/tmp/work.pdf',
    shouldSerialize: false,
    shouldSerializeDirtyState: false,
};

function resolveRoute(
    config: Partial<IDocumentSaveRouteConfig> = {},
    context: Partial<IDocumentSaveRouteContext> = {},
) {
    return resolveDocumentSaveRoute(
        {
            ...BASE_CONFIG,
            ...config,
        },
        {
            ...BASE_CONTEXT,
            ...context,
        },
    );
}

describe('documentSaveRoutes', () => {
    it('uses the current working copy for clean Save and Save As flows', () => {
        expect(resolveRoute()).toBe('working-copy');
        expect(resolveRoute({
            mode: 'save_as',
            shouldPreferWorkingCopy: false,
        })).toBe('working-copy');
    });

    it('uses the native working-copy route for clean forced rewrite operations when available', () => {
        expect(resolveRoute({
            forceSerialize: true,
            forceRewrite: true,
            canPersistNativeWorkingCopy: true,
        }, {shouldSerialize: true})).toBe('native-working-copy');
    });

    it('falls through to native mutations or serialization when document edits need save planning', () => {
        expect(resolveRoute({}, {
            shouldSerialize: true,
            shouldSerializeDirtyState: true,
        })).toBe('native-mutations-or-serialized');
        expect(resolveRoute({
            forceSerialize: true,
            forceRewrite: true,
            canPersistNativeWorkingCopy: false,
        }, {shouldSerialize: true})).toBe('native-mutations-or-serialized');
    });
});
