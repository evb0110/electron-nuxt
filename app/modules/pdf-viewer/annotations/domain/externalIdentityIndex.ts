import type {
    AnnotationId,
    IAnnotationIdentity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

type TBindingKey = Exclude<keyof IAnnotationIdentity, 'id'>;

export class ExternalIdentityConflictError extends Error {}

export class ExternalIdentityIndex {
    readonly #indexes: Record<TBindingKey, Map<string, AnnotationId>> = {
        pdfRef: new Map(),
        pdfName: new Map(),
        pdfjsUid: new Map(),
        elementId: new Map(),
    };

    bind(identity: IAnnotationIdentity) {
        const staged: Array<[TBindingKey, string]> = [];
        for (const key of Object.keys(this.#indexes) as TBindingKey[]) {
            const value = identity[key]?.trim();
            if (!value) continue;
            const owner = this.#indexes[key].get(value);
            if (owner && owner !== identity.id) {
                throw new ExternalIdentityConflictError(`${key} ${value} is already bound to ${owner}`);
            }
            staged.push([
                key,
                value,
            ]);
        }
        staged.forEach(([
            key,
            value,
        ]) => this.#indexes[key].set(value, identity.id));
    }

    resolve(bindings: Omit<IAnnotationIdentity, 'id'>): AnnotationId | null {
        const matches = new Set<AnnotationId>();
        for (const key of Object.keys(this.#indexes) as TBindingKey[]) {
            const value = bindings[key]?.trim();
            if (!value) continue;
            const match = this.#indexes[key].get(value);
            if (match) matches.add(match);
        }
        if (matches.size > 1) {
            throw new ExternalIdentityConflictError('External bindings resolve to different annotations');
        }
        return matches.values().next().value ?? null;
    }

    clear() {
        Object.values(this.#indexes).forEach(index => index.clear());
    }
}
