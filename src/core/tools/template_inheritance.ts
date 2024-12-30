import assert from 'assert';
import xpath from 'xpath';
import * as xml from './xml';
import { ValueError } from '../helper/errors';
import { chain, extend, len } from './iterable';
import { _t } from './translate';

/**
 * Add text before `'node'` in its XML tree. 
 * @param node 
 * @param text 
 * @returns 
 */
export function addTextBefore(node: Element, text: string) {
  if (text == null) {
    return;
  }
  const prev = node.previousSibling as any;
  if (xml.isText(prev)) {
    prev.appendData(text);
  }
  else {
    const newChild = node.ownerDocument.createTextNode(text);
    if (node.firstChild) {
      node.insertBefore(newChild, node.firstChild);
    } else {
      node.appendChild(newChild);
    }
  }
}

/**
 * Add text inside `'node'`.
 * @param node 
 * @param text 
 * @returns 
 */
export function addTextInside(node: Element, text: string) {
  if (text == null) {
    return;
  }
  if (xml.isText(node)) {
    (node as any).appendData(text);
  }
  else {
    const newChild = node.ownerDocument.createTextNode(text);
    node.appendChild(newChild);
  }
}

/**
 * Remove ``node`` but not its tail, from its XML tree.
 * @param node 
 */
export function removeElement(node) {
  node.parentNode.removeChild(node);
}

/**
 * Locate a node in a source (parent) architecture.

    Given a complete source (parent) architecture (i.e. the field
    `arch` in a view), and a 'spec' node (a node in an inheriting
    view that specifies the location in the source view of what
    should be changed), return (if it exists) the node in the
    source view matching the specification.
 * @param arch a parent architecture to modify
 * @param spec a modifying node in an inheriting view
 * @returns a node in the source matching the spec
 */
export function locateNode(arch: Element, spec: Element) {
  if (spec.tagName === 'xpath') {
    const expr = spec.getAttribute('expr');
    let node: any;
    try {
      node = xpath.select1(expr, arch);
    } catch (e) {
      throw new ValueError("XPathSyntaxError while parsing xpath: %s", expr);
    }
    return node;
  }
  else if (spec.tagName === 'field') {
    // Only compare the field name: a field can be only once in a given view
    // at a given level (and for multilevel expressions, we should use xpath
    // inheritance spec anyway).
    const name = spec.getAttribute('name');
    const expr = `//field[@name="${name}"]`;
    const nodes: any[] = xpath.select(expr, arch) ?? [];
    for (const node of nodes) {
      if (node.getAttribute('name') === name) {
        return node;
      }
    }
    return null;
  }

  const expr = `//${spec.tagName}`;
  const specAttrs = Array.from(spec.attributes).filter(attr => !['position', 'version'].includes(attr.name));
  const nodes: any[] = xpath.select(expr, arch) ?? [];
  for (const node of nodes) {
    if (xml.SKIPPED_ELEMENT_TYPES.includes(node.nodeType)) {
      continue;
    }
    if (specAttrs.every(attr => node.getAttribute(attr.name) === spec.getAttribute(attr.name))) {
      // Version spec should match parent's root element's version
      if (spec.getAttribute('version') && spec.getAttribute('version') !== arch.getAttribute('version')) {
        return null;
      }
      return node;
    }
  }
  return null;
}

/**
 * Apply an inheriting view (a descendant of the base view)

    Apply to a source architecture all the spec nodes (i.e. nodes
    describing where and what changes to apply to some parent
    architecture) given by an inheriting view.

    @param source a parent architecture to modify
    @param specsTree a modifying architecture in an inheriting view
    @param inheritBranding
    @param preLocate function that is executed before locating a node.
                        This function receives an arch as argument.
                        This is required by studio to properly handle groupIds.
    @return Element: a modified source where the specs are applied
 */
export async function applyInheritanceSpecs(source: Element, specsTree: Element | Element[], inheritBranding = false, preLocate = (s) => true) {
  /**
   * Utility function that locates a node given a specification, remove
      it from the source and returns it.
   * @param spec 
   * @returns 
   */
  async function extract(spec: Element) {
    if (len(spec)) {
      throw new ValueError(
        await _t("Invalid specification for moved nodes: %s", xml.serializeXml(spec))
      );
    }
    preLocate(spec);
    const toExtract = locateNode(source, spec);
    if (toExtract != null) {
      removeElement(toExtract);
      return toExtract;
    }
    else {
      throw new ValueError(
        await _t("Element %s cannot be located in parent view", xml.serializeHtml(spec))
      );
    }
  }

  // Queue of specification nodes (i.e. nodes describing where and
  // changes to apply to some parent architecture).
  const specs: Element[] = Array.isArray(specsTree) ? specsTree : [specsTree];

  while (len(specs)) {
    const spec = specs.shift();
    if (xml.SKIPPED_ELEMENT_TYPES.includes(spec.nodeType)) {
      continue;
    }
    if (spec.tagName === 'data') {
      extend(specs, Array.from(spec.childNodes));
      continue;
    }
    preLocate(spec);
    let node = locateNode(source, spec);
    if (node != null) {
      const pos = spec.getAttribute('position') || 'inside';
      if (pos === 'replace') {
        const mode = spec.getAttribute('mode') || 'outer';
        if (mode === "outer") {
          let nodes: any[] = xpath.select('.//*[text()="$0"]', spec) ?? [];
          for (const loc of nodes) {
            xml.deleteText(loc);
            loc.appendChild(node.cloneNode(true));
          }
          if (node.parentNode == null) {
            let specContent = null;
            let comment = null;
            for (const content in Array.from<any>(spec.childNodes)) {
              if (!xml.isComment(content)) {
                specContent = content;
                break;
              }
              else {
                comment = content;
              }
            }
            source = specContent.cloneNode(true);
            // only keep the t-name of a template root node
            const tName = node.getAttribute('t-name');
            if (tName) {
              source.setAttribute('t-name', tName);
            }
            if (comment != null) {
              const text = xml.getText(source);
              xml.deleteText(source);
              comment.replaceData(0, comment.data.length, text);
              source.insertBefore(comment.cloneNode(), source.firstChild);
            }
          }
          else {
            /**
             * TODO ideally the notion of 'inheritBranding' should
            not exist in this function. Given the current state of
            the code, it is however necessary to know where nodes
            were removed when distributing branding. As a stable
            fix, this solution was chosen: the location is marked
            with a "ProcessingInstruction" which will not impact
            the "Element" structure of the resulting tree.
            Exception: if we happen to replace a node that already
            has xpath branding (root level nodes), do not mark the
            location of the removal as it will mess up the branding
            of siblings elements coming from other views, after the
            branding is distributed (and those processing instructions
            removed).
             */
            if (inheritBranding && !node.getAttribute('data-oe-xpath')) {
              node.insertBefore(node.ownerDocument.createProcessingInstruction(node.tagName, 'apply-inheritance-specs-node-removal'));
            }

            const parent = node.parentNode;
            for (let child of Array.from<any>(spec.childNodes)) {
              if (xml.isElement(child) && child.getAttribute('position') === 'move') {
                child = await extract(child);
              }
              parent.insertBefore(child.cloneNode(true), node);
            }
            parent.removeChild(node);
          }
        }
        else if (mode === "inner") {
          // Replace the entire content of an element
          for (const child of Array.from(node.childNodes)) {
            node.removeChild(child);
          }
          for (const child of Array.from(spec.childNodes)) {
            node.appendChild(child.cloneNode(true));
          }
        }
        else {
          throw new ValueError(await _t("Invalid mode attribute:") + ` '${mode}'`);
        }
      }
      else if (pos === 'attributes') {
        for (const child of Array.from<any>(spec.childNodes).filter(child => xml.isElement(child) && child.nodeName === 'attribute')) {
          const attribute = child.getAttribute('name');
          let value = xml.getText(child, '');
          if (child.getAttribute('add') || child.getAttribute('remove')) {
            assert(!xml.getText(child));
            let separator = child.getAttribute('separator') || ',';
            if (separator === ' ') {
              separator = null    // squash spaces
            }
            const toAdd = [];
            for (let s of (child.getAttribute('add') || '').split(separator)) {
              s = s.trim();
              if (s) {
                toAdd.push(s);
              }
            }
            const toRemove = new Set<string>();
            for (let s of (child.getAttribute('remove') || '').split(separator)) {
              s = s.trim();
              toRemove.add(s);
            }
            const values = [];
            for (let s of (child.getAttribute(attribute) || '').split(separator)) {
              s = s.trim();
              values.push(s);
            }
            value = [...chain(values.filter(v => !toRemove.has(v)), toAdd)].join(separator || ' ');
          }
          if (value) {
            node.setAttribute(attribute, value);
          }
          else if (node.hasAttribute(attribute)) {
            node.removeAttribute(attribute);
          }
        }
      }
      else if (pos === 'inside') {
        addTextInside(node, xml.getText(spec));
        for (let child of Array.from<any>(spec.childNodes)) {
          if (xml.isElement(child) && child.getAttribute('position') === 'move') {
            child = await extract(child);
          }
          node.appendChild(child.cloneNode(true));
        }
      }
      else if (pos === 'after') {
        // add a sentinel element right after node, insert content of
        // spec before the sentinel, then remove the sentinel element
        const sentinel = node.ownerDocument.createElement('sentinel') as Element;
        const parent = node.parentNode as Element;
        if (node.nextSibling) {
          if (xml.isText(node.nextSibling) && node.nextSibling.nextSibling) {
            node = node.nextSibling; // bypass text
          }
          parent.insertBefore(sentinel, node.nextSibling);
        }
        else {
          parent.appendChild(sentinel);
        }
        for (let child of Array.from<any>(spec.childNodes)) {
          if (xml.isElement(child) && child.getAttribute('position') === 'move') {
            child = await extract(child);
          }
          parent.insertBefore(child.cloneNode(true), sentinel);
        }
        parent.removeChild(sentinel);
      }
      else if (pos === 'before') {
        const parent = node.parentNode as Element;
        if (!xml.isElement(node.previousSibling)) {
          node = node.previousSibling; // bypass text
        }
        for (let child of Array.from<any>(spec.childNodes)) {
          if (xml.isElement(child) && child.getAttribute('position') === 'move') {
            child = await extract(child);
          }
          parent.insertBefore(child.cloneNode(true), node);
        }
      }
      else {
        throw new ValueError(
          await _t("Invalid position attribute: '%s'", pos)
        )
      }
    }
    else {
      const attrs = [];
      for (const attr of Array.from<Attr>(spec.attributes)) {
        if (attr.name !== 'position') {
          attrs.push(` ${attr.name}="${spec.getAttribute(attr.name)}"`);
        }
      }
      const tag = `<${spec.tagName}${attrs.join('')}>`;
      throw new ValueError(
        await _t("Element '%s' cannot be located in parent view", tag)
      );
    }
  }
  return source;
}