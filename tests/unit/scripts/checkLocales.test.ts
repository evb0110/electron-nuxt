import {
    describe,
    expect,
    it,
} from 'vitest';
import { checkLocaleParity } from '@scripts/checkLocales';

const schema = {
    actions: {
        cancel: 'Cancel',
        save: 'Save {name}',
    },
    title: 'Example',
};

describe('locale parity checker', () => {
    it('reports every missing key with its locale', () => {
        expect(checkLocaleParity('desktop', schema, {de: {actions: {cancel: 'Abbrechen'}}})).toEqual([
            'desktop locale "de" missing key "actions.save"',
            'desktop locale "de" missing key "title"',
        ]);
    });

    it('reports every extra key with its locale', () => {
        expect(checkLocaleParity('desktop', schema, {fr: {
            actions: {
                cancel: 'Annuler',
                save: 'Enregistrer {name}',
            },
            obsolete: 'Obsolète',
            title: 'Exemple',
        }})).toEqual(['desktop locale "fr" extra key "obsolete"']);
    });

    it('accepts a complete locale with matching placeholders', () => {
        expect(checkLocaleParity('desktop', schema, {es: {
            actions: {
                cancel: 'Cancelar',
                save: 'Guardar {name}',
            },
            title: 'Ejemplo',
        }})).toEqual([]);
    });
});
