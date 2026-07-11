import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {IPageIdentityDelta} from '@contracts/electronApiPageOps';
import type {
    AnnotationEntity,
    AnnotationId,
    IIdentityBindingEvent,
    IShapeEntity,
    IStickyNoteEntity,
    ITextMarkupEntity,
    TAnnotationStyle,
} from '@app/modules/pdf-viewer/annotations/domain/annotationEntity';
import { normalizeAnnotationText } from '@app/modules/pdf-viewer/annotations/domain/annotationEntity';
import { ExternalIdentityIndex } from '@app/modules/pdf-viewer/annotations/domain/externalIdentityIndex';

interface IHistoryEntry {
    before: AnnotationEntity | null;
    after: AnnotationEntity | null
}
type TAnnotationProjectionExecutor = (
    next: AnnotationEntity | null,
    previous: AnnotationEntity | null,
) => void;
interface IAnnotationHistoryCommand {
    cmd: () => void;
    undo: () => void;
}
export interface IAnnotationHistoryAuthority {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    registerCommand: (command: IAnnotationHistoryCommand) => void;
    undo: () => boolean;
    redo: () => boolean;
}
export interface IAnnotationSaveFrontier {
    readonly documentRevisionToken: TDocumentRevisionToken | null;
    readonly epoch: number;
    readonly entityBaselineHash: string;
    readonly revisions: ReadonlyMap<AnnotationId, number>;
}
type TListener = (entities: readonly AnnotationEntity[]) => void;

function cloneEntity<T extends AnnotationEntity>(entity: T): T {
    return structuredClone(entity);
}

class LocalAnnotationHistoryAuthority implements IAnnotationHistoryAuthority {
    readonly #undo: IAnnotationHistoryCommand[] = [];
    readonly #redo: IAnnotationHistoryCommand[] = [];

    get canUndo() { return this.#undo.length > 0; }
    get canRedo() { return this.#redo.length > 0; }
    registerCommand(command: IAnnotationHistoryCommand) {
        this.#undo.push(command);
        this.#redo.length = 0;
    }
    undo() {
        const command = this.#undo.pop();
        if (!command) {
            return false;
        }
        command.undo();
        this.#redo.push(command);
        return true;
    }
    redo() {
        const command = this.#redo.pop();
        if (!command) {
            return false;
        }
        command.cmd();
        this.#undo.push(command);
        return true;
    }
}

export class AnnotationStore {
    readonly #entities = new Map<AnnotationId, AnnotationEntity>();
    readonly #identities = new ExternalIdentityIndex();
    readonly #listeners = new Set<TListener>();
    readonly #history: IAnnotationHistoryAuthority;
    #mutationEpoch = 0;

    constructor(history: IAnnotationHistoryAuthority = new LocalAnnotationHistoryAuthority()) {
        this.#history = history;
    }

    list(options: { includeDeleted?: boolean } = {}) {
        return Array.from(this.#entities.values())
            .filter(entity => options.includeDeleted === true || !entity.deleted)
            .map(cloneEntity);
    }

    get(id: AnnotationId) {
        const entity = this.#entities.get(id);
        return entity ? cloneEntity(entity) : null;
    }

    subscribe(listener: TListener) {
        this.#listeners.add(listener);
        listener(this.list());
        return () => this.#listeners.delete(listener);
    }

    import(entity: AnnotationEntity) {
        const current = this.#entities.get(entity.identity.id);
        if (current && current.revision > entity.revision) {
            return current;
        }
        this.#identities.bind(entity.identity);
        this.#entities.set(entity.identity.id, cloneEntity(entity));
        this.#mutationEpoch += 1;
        this.#emit();
        return entity;
    }

    createStickyNote(entity: IStickyNoteEntity) { return this.#create(entity); }
    createTextMarkup(entity: ITextMarkupEntity) { return this.#create(entity); }
    createShape(entity: IShapeEntity) { return this.#create(entity); }

    createShapeProjected(entity: IShapeEntity, project: TAnnotationProjectionExecutor) {
        return this.#create(entity, project);
    }

    setNoteText(id: AnnotationId, text: string) {
        return this.#update(id, (entity) => {
            if (entity.kind !== 'sticky-note') throw new Error('setNoteText requires a sticky note');
            return {
                ...entity,
                text: normalizeAnnotationText(text),
            };
        });
    }

    setStyle(id: AnnotationId, style: TAnnotationStyle) {
        return this.#update(id, (entity) => {
            if (entity.kind === 'shape') {
                const geometry = {...structuredClone(entity.geometry)};
                if (style.color !== null) geometry.color = style.color;
                if ('fillColor' in style && style.fillColor !== undefined) geometry.fillColor = style.fillColor;
                if ('opacity' in style && style.opacity !== undefined && style.opacity !== null) geometry.opacity = style.opacity;
                if ('strokeWidth' in style && style.strokeWidth !== undefined) geometry.strokeWidth = style.strokeWidth;
                return {
                    ...entity,
                    geometry,
                };
            }
            return {
                ...entity,
                ...style,
            };
        });
    }

    moveAnchor(id: AnnotationId, anchor: IAnnotationMarkerRect) {
        return this.#update(id, (entity) => {
            if (entity.kind !== 'sticky-note') throw new Error('moveAnchor requires a sticky note');
            return {
                ...entity,
                anchor: structuredClone(anchor),
            };
        });
    }

    replaceShapeGeometry(id: AnnotationId, geometry: IShapeEntity['geometry']) {
        return this.#update(id, (entity) => {
            if (entity.kind !== 'shape') throw new Error('replaceShapeGeometry requires a shape');
            if (geometry.id !== entity.geometry.id || geometry.pageIndex !== entity.pageIndex) {
                throw new Error('Shape identity and pageIndex are immutable');
            }
            return {
                ...entity,
                geometry: structuredClone(geometry),
            };
        });
    }

    replaceShapeGeometryProjected(
        id: AnnotationId,
        geometry: IShapeEntity['geometry'],
        project: TAnnotationProjectionExecutor,
        historyBeforeGeometry?: IShapeEntity['geometry'],
    ) {
        const current = this.#require(id);
        if (current.kind !== 'shape') throw new Error('replaceShapeGeometry requires a shape');
        if (geometry.id !== current.geometry.id || geometry.pageIndex !== current.pageIndex) {
            throw new Error('Shape identity and pageIndex are immutable');
        }
        const before = historyBeforeGeometry
            ? {
                ...current,
                geometry: structuredClone(historyBeforeGeometry),
                revision: Math.max(0, current.revision - 1),
            }
            : cloneEntity(current);
        const after = {
            ...current,
            geometry: structuredClone(geometry),
            revision: current.revision + 1,
            modifiedAt: Date.now(),
        };
        this.#commit({
            before,
            after,
        }, project);
        return cloneEntity(after);
    }

    previewShapeGeometryProjected(
        id: AnnotationId,
        geometry: IShapeEntity['geometry'],
        project: TAnnotationProjectionExecutor,
    ) {
        const before = this.#require(id);
        if (before.kind !== 'shape') throw new Error('replaceShapeGeometry requires a shape');
        if (geometry.id !== before.geometry.id || geometry.pageIndex !== before.pageIndex) {
            throw new Error('Shape identity and pageIndex are immutable');
        }
        const after = {
            ...before,
            geometry: structuredClone(geometry),
            revision: before.revision + 1,
            modifiedAt: Date.now(),
        };
        this.#applyProjected(after, before, project);
        return cloneEntity(after);
    }

    delete(id: AnnotationId) {
        return this.#update(id, entity => ({
            ...entity,
            deleted: true,
        }));
    }

    deleteProjected(id: AnnotationId, project: TAnnotationProjectionExecutor) {
        const before = this.#require(id);
        if (before.deleted) throw new Error(`Annotation ${id} is deleted`);
        const after = {
            ...before,
            deleted: true,
            revision: before.revision + 1,
            modifiedAt: Date.now(),
        };
        this.#commit({
            before: cloneEntity(before),
            after,
        }, project);
        return cloneEntity(after);
    }

    restore(id: AnnotationId) {
        const before = this.#require(id);
        if (!before.deleted) {
            return cloneEntity(before);
        }
        const after = {
            ...before,
            deleted: false,
            revision: before.revision + 1,
            modifiedAt: Date.now(),
        };
        this.#commit({
            before: cloneEntity(before),
            after,
        });
        return cloneEntity(after);
    }

    bindIdentity(event: IIdentityBindingEvent) {
        const entity = this.#require(event.annotationId);
        if (entity.revision !== event.expectedRevision) {
            throw new Error(`Stale identity binding for ${event.annotationId}`);
        }
        const identity = {
            ...entity.identity,
            ...event.bindings,
        };
        this.#identities.bind(identity);
        this.#entities.set(event.annotationId, {
            ...entity,
            identity,
        });
        this.#mutationEpoch += 1;
        this.#emit();
    }

    resolveExternal(bindings: Parameters<ExternalIdentityIndex['resolve']>[0]) {
        return this.#identities.resolve(bindings);
    }

    /** Projects a committed page-tree delta without creating a second undo entry. */
    remapPages(delta: IPageIdentityDelta) {
        const newPageByOldPage = new Map<number, number>();
        delta.pages.forEach((page, nextPageIndex) => {
            if ('fromPageNumber' in page) newPageByOldPage.set(page.fromPageNumber - 1, nextPageIndex);
        });
        this.#entities.forEach((entity, id) => {
            const nextPageIndex = newPageByOldPage.get(entity.pageIndex);
            if (nextPageIndex === undefined) {
                this.#entities.set(id, {
                    ...entity,
                    deleted: true,
                });
                return;
            }
            this.#entities.set(id, entity.kind === 'shape'
                ? {
                    ...entity,
                    pageIndex: nextPageIndex,
                    geometry: {
                        ...entity.geometry,
                        pageIndex: nextPageIndex,
                    },
                }
                : {
                    ...entity,
                    pageIndex: nextPageIndex,
                });
        });
        this.#mutationEpoch += 1;
        this.#emit();
    }

    beginSave(documentRevisionToken: TDocumentRevisionToken | null = null): IAnnotationSaveFrontier {
        const entities = this.list({includeDeleted: true});
        return {
            documentRevisionToken,
            epoch: this.#mutationEpoch,
            entityBaselineHash: JSON.stringify(entities.map(entity => [
                entity.identity.id,
                entity.revision,
                entity.deleted,
            ])),
            revisions: new Map(entities.map(entity => [
                entity.identity.id,
                entity.revision,
            ])),
        };
    }

    acknowledgeSave(frontier: IAnnotationSaveFrontier) {
        this.assertSaveFrontierCurrent(frontier);
        frontier.revisions.forEach((revision, id) => {
            const entity = this.#entities.get(id);
            if (entity?.revision === revision) {
                this.#entities.set(id, {
                    ...entity,
                    persistedRevision: revision,
                });
            }
        });
        this.#emit();
    }

    assertSaveFrontierCurrent(frontier: IAnnotationSaveFrontier) {
        if (frontier.epoch !== this.#mutationEpoch) {
            throw new Error('staleRevisionError: annotations changed after the save frontier was captured');
        }
    }

    dirtyAt(frontier: IAnnotationSaveFrontier) {
        return this.list({includeDeleted: true}).filter(entity => {
            const frontierRevision = frontier.revisions.get(entity.identity.id);
            return frontierRevision !== undefined && frontierRevision > entity.persistedRevision;
        });
    }

    undo() { return this.#history.undo(); }
    redo() { return this.#history.redo(); }
    get canUndo() { return this.#history.canUndo; }
    get canRedo() { return this.#history.canRedo; }

    #create(entity: AnnotationEntity, project?: TAnnotationProjectionExecutor) {
        if (this.#entities.has(entity.identity.id)) throw new Error(`Duplicate AnnotationId ${entity.identity.id}`);
        if (entity.revision !== 0 || entity.persistedRevision !== -1) {
            throw new Error('New annotations must start at revision 0 with persistedRevision -1');
        }
        this.#identities.bind(entity.identity);
        this.#commit({
            before: null,
            after: cloneEntity(entity),
        }, project);
        return entity;
    }

    #update(id: AnnotationId, update: (entity: AnnotationEntity) => AnnotationEntity) {
        const before = this.#require(id);
        if (before.deleted) throw new Error(`Annotation ${id} is deleted`);
        const candidate = update(cloneEntity(before));
        if (candidate.identity.id !== id || candidate.pageIndex !== before.pageIndex) {
            throw new Error('Annotation identity and pageIndex are immutable');
        }
        const after = {
            ...candidate,
            revision: before.revision + 1,
            modifiedAt: Date.now(),
        };
        this.#commit({
            before: cloneEntity(before),
            after,
        });
        return cloneEntity(after);
    }

    #commit(entry: IHistoryEntry, project?: TAnnotationProjectionExecutor) {
        const id = (entry.before ?? entry.after)?.identity.id;
        if (!id) {
            throw new Error('History entry has no annotation identity');
        }
        const apply = (value: AnnotationEntity | null) => {
            if (value) this.#entities.set(id, cloneEntity(value));
            else this.#entities.delete(id);
            this.#mutationEpoch += 1;
            this.#emit();
        };
        const applyProjected = (value: AnnotationEntity | null, rollback: AnnotationEntity | null) => {
            apply(value);
            if (!project) {
                return;
            }
            try {
                project(value ? cloneEntity(value) : null, rollback ? cloneEntity(rollback) : null);
            } catch (error) {
                apply(rollback);
                throw error;
            }
        };
        applyProjected(entry.after, entry.before);
        this.#history.registerCommand({
            cmd: () => applyProjected(entry.after, entry.before),
            undo: () => applyProjected(entry.before, entry.after),
        });
    }

    #applyProjected(
        value: AnnotationEntity,
        rollback: AnnotationEntity,
        project: TAnnotationProjectionExecutor,
    ) {
        const id = value.identity.id;
        this.#entities.set(id, cloneEntity(value));
        this.#mutationEpoch += 1;
        this.#emit();
        try {
            project(cloneEntity(value), cloneEntity(rollback));
        } catch (error) {
            this.#entities.set(id, cloneEntity(rollback));
            this.#mutationEpoch += 1;
            this.#emit();
            throw error;
        }
    }

    #require(id: AnnotationId) {
        const entity = this.#entities.get(id);
        if (!entity) throw new Error(`Unknown annotation ${id}`);
        return entity;
    }

    #emit() {
        const snapshot = this.list();
        this.#listeners.forEach(listener => listener(snapshot));
    }
}
