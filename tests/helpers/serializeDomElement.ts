/**
 * A structural, tag-agnostic snapshot of a live element tree.
 *
 * Serializing rendered markup to an HTML string and re-parsing it silently
 * rewrites structures the HTML parser disallows but the DOM permits — a nested
 * `<button>`, for instance, is hoisted out of its parent. Transferring the tree
 * node by node reproduces exactly what a component rendered, which is what a test
 * needs when it hands one runtime's output to another for layout.
 */

export interface ISerializedElement {
    attributes: Array<[string, string]>;
    children: Array<ISerializedElement | string>;
    tagName: string;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

export function serializeDomElement(element: Element): ISerializedElement {
    return {
        attributes: [...element.attributes].map(attribute => [
            attribute.name,
            attribute.value,
        ]),
        children: [...element.childNodes].flatMap((node): Array<ISerializedElement | string> => {
            if (node.nodeType === TEXT_NODE) {
                return [node.textContent ?? ''];
            }
            if (node.nodeType === ELEMENT_NODE) {
                return [serializeDomElement(node as Element)];
            }
            return [];
        }),
        tagName: element.tagName.toLowerCase(),
    };
}
