import _ from "lodash";
import uuid from "uuid";
import xpath from "xpath";
import { api } from "../../../core";
import { AccessError, ValidationError, ValueError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { bool, equal, f, isInstance, len, parseInt, update, zip } from "../../../core/tools";
import { E, getAttributes, getObjectAttributes, isElement, iterchildren, parseXml, serializeXml } from "../../../core/tools/xml";

const EDITING_ATTRIBUTES = ['data-oe-model', 'data-oe-id', 'data-oe-field', 'data-oe-xpath', 'data-note-id']

@MetaModel.define()
class IrUiView extends Model {
    static _module = module;
    static _parents = 'ir.ui.view';

    async _render(values?: any, engine: string='ir.qweb', minimalQcontext: boolean=false) {
        if (values && values['editable']) {
            try {
                await this.checkAccessRights('write');
                await this.checkAccessRule('write');
            } catch(e) {
              if (isInstance(e, AccessError)) {
                values['editable'] = false;
              } else {
                throw e;
              }
            }
        }
        return _super(IrUiView, this)._render(values, engine, minimalQcontext);
    }

    // Save from html

    @api.model()
    extractEmbeddedFields(arch) {
        return xpath.select('//*[@data-oe-model != "ir.ui.view"]', arch) as Element[];
    }

    @api.model()
    extractOeStructures(arch) {
        return xpath.select('//*[contains(@class,"oe-structure")][contains(@id,"oeStructure")]', arch) as Element[];
    }

    @api.model()
    async getDefaultLangCode() {
        return false;
    }

    @api.model()
    async saveEmbeddedField(el) {
        const model = this.env.items(el.getAttribute('data-oe-model'));
        const field = el.getAttribute('data-oe-field');

        const modelName = 'ir.qweb.field.' + el.getAttribute('data-oe-type');
        const converter = modelName in this.env.models ? this.env.items(modelName) : this.env.items('ir.qweb.field');

        let value;
        try {
            value = await converter.fromHtml(model, model._fields[field], el);
        } catch(e) {
          if (isInstance(e, ValueError)) {
            throw new ValidationError(await this._t("Invalid field value for %s: %s", model._fields[field].string, el.textContent.trim()));
          } else {
            throw e;
          }
        }
        if (value != null) {
            // TODO: batch writes?
            if (! this.env.context['lang'] && await this.getDefaultLangCode()) {
                await (await model.browse(parseInt(el.getAttribute('data-oe-id'))).withContext({lang: await this.getDefaultLangCode()})).write({[field]: value});
            }
            else {
                await model.browse(parseInt(el.getAttribute('data-oe-id'))).write({[field]: value});
            }
        }
    }

    async saveOeStructure(el) {
        this.ensureOne();

        if ((await this['key']).includes(el.getAttribute('id'))) {
            // Do not inherit if the oe-structure already has its own inheriting view
            return false;
        }
        const arch = E.withType('data');
        const xpath = E.withType('xpath', {expr: `//*[contains(@class,'oe-structure')][@id='${el.getAttribute('id')}']`, position: "replace"});
        arch.appendChild(xpath);
        const attributes = Object.fromEntries(getAttributes(el).filter(attr => !EDITING_ATTRIBUTES.includes(attr.name)).map(attr => [attr.name, attr.value]));
        const structure = E.withType(el.tagname, attributes);
        structure.textContent = el.textContent;
        xpath.appendChild(structure);
        for (const child of iterchildren(el, isElement)) {
            structure.appendChild(child.cloneNode(true));
        }

        const vals = {
            'inheritId': this.id,
            'label': f('%s (%s)', await this['label'], el.getAttribute('id')),
            'arch': this._prettyArch(arch),
            'key': f('%s_%s', await this['key'], el.getAttribute('id')),
            'type': 'qweb',
            'mode': 'extension',
        }
        update(vals, this._saveOeStructureHook());
        await this.env.items('ir.ui.view').create(vals);

        return true;
    }

    @api.model()
    _saveOeStructureHook() {
        return {};
    }

    @api.model()
    _prettyArch(arch) {
        let str = serializeXml(arch);
        str = str.replace(/>\s*/g, '>');  // Replace "> " with ">"
        str = str.replace(/\s*</g, '<');  // Replace "< " with "<"
        const archNoWhitespace = parseXml(str);
        return serializeXml(archNoWhitespace, 'unicode', true);
    }
        
    @api.model()
    _areArchsEqual(arch1, arch2) {
        // Note that comparing the strings would not be ok as attributes order
        // must not be relevant
        if (arch1.tagName != arch2.tagName) {
            return false;
        }
        if (arch1.textContent != arch2.textContent) {
            return false;
        }
        if (len(arch1.attributes) != len(arch2.attributes)) {
            return false;
        }
        if (equal(getObjectAttributes(arch1), getObjectAttributes(arch2))) {
            return false;
        }
        if (len(arch1.childNodes) != len(arch2.childNodes)) {
            return false;
        }
        for (const [child1, child2] of zip(arch1, arch2)) {
            if (!this._areArchsEqual(child1, child2)) {
                return false;
            }
        }
        return true;
    }

    @api.model()
    async _getAllowedRootAttrs() {
        return ['style', 'class'];
    }

    async replaceArchSection(sectionXpath, replacement, replaceTail: boolean=false) {
        // the root of the arch section shouldn't actually be replaced as it's
        // not really editable itself, only the content truly is editable.
        this.ensureOne();
        const arch = parseXml(await this['arch']);
        // => get the replacement root
        let root;
        if (! sectionXpath) {
            root = arch;
        }
        else {
            // ensure there's only one match
            root = xpath.select1(sectionXpath, arch) as Element;
        }
        root.textContent = replacement.textContent;

        // We need to replace some attrib for styles changes on the root element
        for (const attribute of await this._getAllowedRootAttrs()) {
            if (replacement.hasAttribute(attribute)) {
                root.setAttribute(attribute, replacement.getAttribute(attribute));
            }
        }

        // Note: after a standard edition, the tail *must not* be replaced
        if (replaceTail) {
            // root.tail = replacement.tail;
        }
        // replace all children
        while (root.hasChildNodes()) root.removeChild(root.lastChild);
        for (const child of iterchildren(replacement)) {
            root.appendChild(child.cloneNode(true));
        }

        return arch;
    }

    @api.model()
    toFieldRef(el) {
        // filter out meta-information inserted in the document
        const attributes = getObjectAttributes(el, (a) => !a.name.startsWith('data-oe-'));
        attributes['t-field'] = el.getAttribute('data-oe-expression');

        const out = E.withType(el.tagname, attributes);
        // out.tail = el.tail
        return out;
    }

    @api.model()
    toEmptyOeStructure(el) {
        const out = E.withType(el.tagName, getObjectAttributes(el));
        // out.tail = el.tail
        return out;
    }

    @api.model()
    async _setNoupdate() {
        await (await (await this.sudo()).mapped('modelDataId')).write({'noupdate': true});
    }

    /**
     * Update a view section. The view section may embed fields to write

        Note that `self` record might not exist when saving an embed field

        :param str xpath: valid xpath to the tag to replace
     * @param value 
     * @param xpath 
     * @returns 
     */
    async save(value, xpath?: any) {
        this.ensureOne();
        let archSection = parseXml(value, 'utf-8');

        if (xpath == null) {
            // value is an embedded field on its own, not a view section
            await this.saveEmbeddedField(archSection);
            return;
        }
        for (const el of this.extractEmbeddedFields(archSection)) {
            await this.saveEmbeddedField(el);

            // transform embedded field back to t-field
            el.parentNode.replaceChild(this.toFieldRef(el), el);
        }
        
        for (const el of this.extractOeStructures(archSection)) {
            if (await this.saveOeStructure(el)) {
                // empty oe-structure in parent view
                const empty = this.toEmptyOeStructure(el);
                if (el == archSection) {
                    archSection = empty;
                }
                else {
                    el.parentNode.replaceChild(empty, el);
                }
            }
        }

        const newArch = await this.replaceArchSection(xpath, archSection);
        const oldArch = parseXml(await this['arch']);
        if (! this._areArchsEqual(oldArch, newArch)) {
            await this._setNoupdate();
            await this.write({'arch': this._prettyArch(newArch)});
        }
    }

    @api.model()
    async _viewGetInheritedChildren(view) {
        if (this._context['noPrimaryChildren'] ?? false) {
            const originalHierarchy = this._context['__viewsGetOriginalHierarchy'] ?? [];
            return (await view.inheritChildrenIds).filtered(async (extension) => await extension.mode !== 'primary' || originalHierarchy.includes(extension.id));
        }
        return view.inheritChildrenIds;
    }

    @api.model()
    async _viewObj(viewId) {
        if (typeof viewId === 'string') {
            const res = await this.search([['key', '=', viewId]], {limit: 1});
            if (res.ok) return res;
            return this.env.ref(viewId);
        }
        else if (typeof viewId === 'number') {
            return this.browse(viewId);
        }
        // It can already be a view object when called by '_viewsGet()' that is calling '_viewObj'
        // for it's inheritChildrenIds, passing them directly as object record.
        return viewId;
    }

    // Returns all views (called and inherited) related to a view
    // Used by translation mechanism, SEO and optional templates

    /**
     * For a given view ``viewId``, should return:
                * the view itself (starting from its top most parent)
                * all views inheriting from it, enabled or not
                  - but not the optional children of a non-enabled child
                * all views called from it (via t-call)
            :returns recordset of ir.ui.view
     * @param viewId 
     * @param opts 
     * @returns 
     */
    @api.model()
    async _viewsGet(viewId, opts: {getChildren?: boolean, bundles?: boolean, root?: boolean, visited?: any[]}={}) {
        update(opts, {getChildren: true, root: true});
        let view;
        try {
            view = await this._viewObj(viewId);
        } catch(e) {
            if (isInstance(e, ValueError)) {
                console.warn("Could not find view object with viewId '%s'", viewId);
                return this.env.items('ir.ui.view');
            } else {
                throw e;
            }
        }

        if (opts.visited == null) {
            opts.visited = [];
        }
        const originalHierarchy = this._context['__viewsGetOriginalHierarchy'] ?? [];
        while (opts.root && bool(await view.inheritId)) {
            originalHierarchy.push(view.id);
            view = await view.inheritId;
        }

        let viewsToReturn = view;

        const node = parseXml(await view.arch);
        let path = '//t[@t-call]';
        if (opts.bundles) {
            path += '| //t[@t-call-assets]';
        }
        for (const child of xpath.select(path, node) as Element[]) {
            let calledView;
            try {
                calledView = await this._viewObj(child.getAttribute('t-call') || child.getAttribute('t-call-assets'));
            } catch(e) {
                if (isInstance(e, ValueError)) {
                    continue;
                } else {
                    throw e
                }
            }
            if (bool(calledView) && !viewsToReturn.includes(calledView) && !opts.visited.includes(calledView.id)) {
                viewsToReturn = viewsToReturn.add(await this._viewsGet(calledView, {getChildren: opts.getChildren, bundles: opts.bundles, visited: opts.visited.concat(viewsToReturn.ids)}));
            }
        }
        if (! opts.getChildren) {
            return viewsToReturn;
        }

        const extensions = await this._viewGetInheritedChildren(view);

        // Keep children in a deterministic order regardless of their applicability
        for (const extension of await extensions.sorted(v => v.id)) {
            // only return optional grandchildren if this child is enabled
            if (!opts.visited.includes(extension.id)) {
                for (const extView of await this._viewsGet(extension, {getChildren: await extension.active, root: false, visited: opts.visited.concat(viewsToReturn.ids)})) {
                    if (!viewsToReturn.includes(extView)) {
                        viewsToReturn = viewsToReturn.add(extView);
                    }
                }
            }
        }
        return viewsToReturn;
    }

    /**
     * Get inherit view's informations of the template ``key``.
            returns templates info (which can be active or not)
            ``bundles=true`` returns also the asset bundles
     * @param key 
     * @param bundles 
     * @returns 
     */
    @api.model()
    async getRelatedViews(key, bundles: boolean=false) {
        const userGroups = await (await this.env.user()).groupsId;
        const view = await this.withContext({activeTest: false, lang: null});
        const views = await view._viewsGet(key, {bundles: bundles});
        console.warn('Todo check');
        return views.filtered(async (v) => ! bool(await v.groupsId) || _.intersection(userGroups, await v.groupsId).length);
    }

    // Snippet saving

    @api.model()
    _getSnippetAdditionViewKey(templateKey, key) {
        return f('%s.%s', templateKey, key);
    }

    @api.model()
    _snippetSaveViewValuesHook() {
        return {};
    }

    _findAvailableName(name, usedNames) {
        let attempt = 1;
        let candidateName = name;
        while (usedNames.includes(candidateName)) {
            attempt += 1;
            candidateName = `${name} (${attempt})`;
        }
        return candidateName;
    }

    /**
     * Saves a new snippet arch so that it appears with the given name when
        using the given snippets template.

        :param name: the name of the snippet to save
        :param arch: the html structure of the snippet to save
        :param templateKey: the key of the view regrouping all snippets in
            which the snippet to save is meant to appear
        :param snippetKey: the key (without module part) to identify
            the snippet from which the snippet to save originates
        :param thumbnailUrl: the url of the thumbnail to use when displaying
            the snippet to save
     * @param name 
     * @param arch 
     * @param templateKey 
     * @param snippetKey 
     * @param thumbnailUrl 
     */
    @api.model()
    async saveSnippet(name, arch, templateKey, snippetKey, thumbnailUrl) {
        const appName = templateKey.split('.')[0];
        snippetKey = f('%s_%s', snippetKey, uuid.v4());
        const fullSnippetKey = f('%s.%s', appName, snippetKey);

        // find available name
        const currentWebsite = this.env.items('website').browse(this._context['websiteId']);
        const websiteDomain = currentWebsite.websiteDomain();
        const usedNames = await (await this.search(expression.AND([
            [['label', '=like', f('%s%', name)]], websiteDomain
        ]))).mapped('label');
        name = this._findAvailableName(name, usedNames);

        // html to xml to add '/' at the end of self closing tags like br, ...
        const xmlArch = arch;//etree.tostring(html.fromstring(arch), encoding='utf-8')
        const newSnippetViewValues = {
            'label': name,
            'key': fullSnippetKey,
            'type': 'qweb',
            'arch': xmlArch,
        }
        update(newSnippetViewValues, this._snippetSaveViewValuesHook());
        await this.create(newSnippetViewValues);

        const customSection = await this.search([['key', '=', templateKey]]);
        const snippetAdditionViewValues = {
            'label': name + ' Block',
            'key': await this._getSnippetAdditionViewKey(templateKey, snippetKey),
            'inheritId': customSection.id,
            'type': 'qweb',
            'arch': f(`
                <data inheritId="%s">
                    <xpath expr="//div[@id='snippetCustom']" position="attributes">
                        <attribute name="class" remove="d-none" separator=" "/>
                    </xpath>
                    <xpath expr="//div[@id='snippetCustomBody']" position="inside">
                        <t t-snippet="%s" t-thumbnail="%s"/>
                    </xpath>
                </data>
            `, templateKey, fullSnippetKey, thumbnailUrl),
        }
        update(snippetAdditionViewValues, this._snippetSaveViewValuesHook());
        await this.create(snippetAdditionViewValues);
    }

    @api.model()
    async renameSnippet(name, viewId, templateKey) {
        const snippetView = this.browse(viewId);
        const key = (await snippetView.key).split('.')[1];
        const customKey = this._getSnippetAdditionViewKey(templateKey, key);
        const snippetAdditionView = await this.search([['key', '=', customKey]]);
        if (snippetAdditionView.ok) {
            await snippetAdditionView.set('label', name + ' Block');
        }
        await snippetView.set('label', name);
    }

    @api.model()
    async deleteSnippet(viewId, templateKey) {
        const snippetView = this.browse(viewId);
        const key = (await snippetView.key).split('.')[1];
        const customKey = await this._getSnippetAdditionViewKey(templateKey, key);
        const snippetAdditionView = await this.search([['key', '=', customKey]]);
        await snippetAdditionView.or(snippetView).unlink();
    }
}