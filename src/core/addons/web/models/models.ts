import assert from "assert";
import _ from "lodash";
import { Fields, _Datetime, api } from "../../..";
import { DefaultDict2, Dict } from "../../../helper/collections";
import { UserError } from "../../../helper/errors";
import { MetaModel, Model, _super } from "../../../models";
import { AND, isTrueLeaf, normalizeDomain } from "../../../osv/expression";
import { _f, allTimezones, b64encode, bool, dateSetTz, equal, formatDate, formatDatetime, getLang, isInstance, len, parseInt, pop, setOptions, startOf, stringPart } from "../../../tools";
import { AbstractModel } from "../../../models";
import { stringify } from "../../../tools/json";
import { E, serializeXml } from "../../../tools/xml";

const SEARCH_PANEL_ERROR_MESSAGE = _lt("Too many items to display.")

const DISPLAY_DATE_FORMATS = {
  'day': 'dd MMM yyyy',
  'week': "'W'w yyyy",
  'month': 'MMMM yyyy',
  'quarter': 'QQQ yyyy',
  'year': 'yyyy',
}

function isTrueDomain(domain) {
  return isTrueLeaf(normalizeDomain(domain)[0])
}

@MetaModel.define()
class IrActionsActwindowView extends Model {
  static _module = module;
  static _parents = 'ir.actions.actwindow.view';

  static viewMode = Fields.Selection({
    selectionAdd: [
      ['qweb', 'QWeb']
    ], ondelete: { 'qweb': 'CASCADE' }
  })
}

@MetaModel.define()
class Base extends AbstractModel {
  static _module = module;
  static _parents = 'base';

  /**
   * Performs a searchRead and a searchCount.

    @param domain search domain
    @param fields list of fields to read
    @param limit maximum number of records to read
    @param offset number of records to skip
    @param order columns to sort results
    @returns: {
        'records': array of read records (result of a call to 'searchRead')
        'length': number of records matching the domain (result of a call to 'searchCount')
    }
   */
  @api.model()
  async webSearchRead(options: { domain?: any, fields?: any, groupby?: any, offset?: number, limit?: number, orderby?: string, lazy?: boolean } = {}) {
    const domain = pop(options, 'domain');
    const fields = pop(options, 'fields');
    setOptions(options, { offset: 0, limit: null, orderby: false, lazy: true })
    const res = await this.searchRead(domain, fields, options);
    if (!res.length) {
      return {
        'length': 0,
        'records': []
      }
    }
    let length;
    if (options.limit && (res.length == options.limit || this.env.context['forceSearchCount'])) {
      length = await this.searchCount(domain);
    }
    else {
      length = res.length + options.offset;
    }
    return {
      'length': length,
      'records': res
    }
  }

  /**
   * Returns the result of a readGroup (and optionally search for and read records inside each
      group), and the total number of groups matching the search domain.

      @param domain search domain
      @param fields list of fields to read (see ``fields``` param of ``readGroup``)
      @param groupby list of fields to group on (see ``groupby``` param of ``readGroup``)
      @param limit see ``limit`` param of ``readGroup``
      @param offset see ``offset`` param of ``readGroup``
      @param orderby see ``orderby`` param of ``readGroup``
      @param lazy see ``lazy`` param of ``readGroup``
      @param expand if true, and groupby only contains one field, read records inside each group
      @param expandLimit maximum number of records to read in each group
      @param expandOrderby order to apply when reading records in each group
      @returns: {
          'groups': array of read groups
          'length': total number of groups
      }
   * @param options 
   * @returns 
   */
  @api.model()
  async webReadGroup(options: { domain?: any, fields?: any, groupby?: any, limit?: any, offset?: number, orderby?: string, lazy?: boolean, expand?: any, expandLimit?: any, expandOrderby?: string } = {}) {
    setOptions(options, { offset: 0, orderby: false, lazy: true, expand: false, expandOrderby: false });
    const groups = await this._webReadGroup(options);

    let length;
    if (!bool(groups)) {
      length = 0;
    }
    else if (options.limit && len(groups) == options.limit) {
      // We need to fetch all groups to know the total number
      // this cannot be done all at once to avoid MemoryError
      length = options.limit;
      const chunkSize = 100000;
      while (true) {
        const more = len(await this.readGroup(options.domain, ['displayName'], options.groupby, { offset: length, limit: chunkSize, lazy: true }));
        length += more;
        if (more < chunkSize) {
          break;
        }
      }
    }
    else {
      length = len(groups) + options.offset;
    }
    return {
      'groups': groups,
      'length': length
    }
  }

  /**
   *  Performs a readGroup and optionally a webSearchRead for each group.
      See ``webReadGroup`` for params description.

   * @param domain 
   * @param fields 
   * @param groupby 
   * @param options 
   * @param limit 
   * @param offset 
   * @param orderby 
   * @param lazy 
   * @param expand 
   * @param expandLimit 
   * @param expandOrderby 
   * @returns array of groups

   */
  @api.model()
  async _webReadGroup(options: { domain?: any, fields?: any, groupby?: any, limit?: number, offset?: number, orderby?: string, lazy?: boolean, expand?: boolean, expandLimit?: number, expandOrderby?: string } = {}) {
    setOptions(options, { offset: 0, lazy: true });
    const domain = pop(options, 'domain');
    const fields = pop(options, 'fields');
    const groupby = pop(options, 'groupby');
    const groups = await this.readGroup(domain, fields, groupby, options);

    if (options.expand && len(groupby) == 1) {
      for (const group of groups) {
        group['__data'] = await this.webSearchRead({ domain: group['__domain'], fields: fields, offset: 0, limit: options.expandLimit, orderby: options.expandOrderby });
      }
    }
    return groups;
  }

  /**
   * Gets the data needed for all the kanban column progressbars.
    These are fetched alongside readGroup operation.

    @param domain - the domain used in the kanban view to filter records
    @param groupby - the name of the field used to group records into
                    kanban columns
    @param progressBar - the <progressbar/> declaration attributes
                        (field, colors, sum)
    @returns a dictionnary mapping groupby values to dictionnaries mapping
            progress bar field values to the related number of records
   */
  @api.model()
  async readProgressBar(opts: {domain?: any, groupby?: any, progressBar?: any}={}) {
    const groupbyFname = stringPart(opts.groupby, ':')[0];
    const fieldType = this._fields[groupbyFname].type;
    let selectionLabels;
    if (fieldType === 'selection') {
      selectionLabels = new Dict((await this.fieldsGet())[opts.groupby]['selection']);
    }

    function adapt(value) {
      if (fieldType === 'selection') {
        value = selectionLabels.get(value, false);
      }
      if (Array.isArray(value)) {
        value = value[1];  // FIXME should use technical value (0)
      }
      return value;
    }

    const result = {};
    for (const group of await this._readProgressBar(opts.domain, opts.groupby, opts.progressBar)) {
      const groupbyValue = String(adapt(group[opts.groupby]));
      const fieldValue = group[opts.progressBar['field']];
      if (!(groupbyValue in result)) {
        result[groupbyValue] = Dict.fromKeys(opts.progressBar['colors'], 0);
      }
      if (fieldValue in result[groupbyValue]) {
        result[groupbyValue][fieldValue] += group['__count'];
      }
    }
    return result;
  }

  /**
   * Implementation of readProgressBar() that returns results in the
        format of readGroup().
   * @param domain 
   * @param groupby 
   * @param progressBar 
   * @returns 
   */
  async _readProgressBar(domain, groupby, progressBar) {
    try {
      const fname = progressBar['field'];
      return await this.readGroup(domain, [fname], [groupby, fname], { lazy: false });
    } catch (e) {
      if (!isInstance(e, UserError)) {
        throw e;
        // possibly failed because of grouping on or aggregating non-stored
        // field; fallback on alternative implementation
      }
    }

    // Workaround to match readGroup's infrastructure
    // TO DO in master: harmonize this function and readgroup to allow factorization
    const groupbyName = stringPart(groupby, ':')[0];
    const groupbyModifier = stringPart(groupby, ':')[2] || 'month';

    const recordsValues = await this.searchRead(domain ?? [], [progressBar['field'], groupbyName]);
    const fieldType = this._fields[groupbyName].type;

    for (const recordValues of recordsValues) {
      let groupbyValue = pop(recordValues, groupbyName);

      // Again, imitating what _readGroupFormatResult and _readGroupPrepareData do
      if (groupbyValue && ['date', 'datetime'].includes(fieldType)) {
        const locale = await (await getLang(this.env)).code;
        groupbyValue = startOf(_Datetime.toDatetime(groupbyValue) as Date, groupbyModifier);
        groupbyValue = dateSetTz(groupbyValue, 'UTC');
        let tzInfo;
        if (fieldType === 'datetime' && allTimezones.includes(this._context['tz'])) {
          tzInfo = this._context['tz'];
          groupbyValue = await formatDatetime(
            this.env,
            groupbyValue, 
            tzInfo, 
            DISPLAY_DATE_FORMATS[groupbyModifier],
            locale
          );
        }
        else {
          groupbyValue = await formatDate(
            groupbyValue, {
              format: DISPLAY_DATE_FORMATS[groupbyModifier],
            locale: locale
          });
        }
      }
      if (fieldType === 'many2many' && Array.isArray(groupbyValue)) {
        groupbyValue = String(Array.from(groupbyValue)) ?? false;
      }

      recordValues[groupby] = groupbyValue;
      recordValues['__count'] = 1
    }
    return recordsValues;
  }
  // ##### qweb view hooks #####
  @api.model()
  async qwebRenderView(viewId, domain) {
    assert(viewId)
    return this.env.items('ir.qweb')._render(viewId, {
      ...await this.env.items('ir.ui.view')._prepareQcontext(),
      ...await this._qwebPrepareQcontext(viewId, domain),
    })
  }

  /**
   *     Base qcontext for rendering qweb views bound to this model

   * @param viewId 
   * @param domain 
   * @returns 
   */
  async _qwebPrepareQcontext(viewId, domain) {
    return {
      'model': this,
      'domain': domain,
      // not necessarily necessary as env is already part of the
      // non-minimal qcontext
      'context': this.env.context,
      'records': await this.search(domain) //lazy(this.search.bind(this), domain),
    }
  }

  @api.model()
  async fieldsViewGet(viewId?: number, viewType: string = 'form', toolbar: boolean = false, submenu: boolean = false) {
    const res = await _super(Base, this).fieldsViewGet(viewId, viewType, toolbar, submenu);
    // avoid leaking the raw (un-rendered) template, also avoids bloating
    // the response payload for no reason. Only send the root node,
    // to send attributes such as `jsClass`.
    if (res['type'] === 'qweb') {
      const root = res['dom'];
      const doc = E.withType('qweb', Object.fromEntries(Array.from<Attr>(root.attributes).map(attr => [attr.name, attr.value])));
      res['dom'] = doc;
      res['arch'] = serializeXml(doc);
    }
    return res;
  }

  /**
   *     Return the values in the image of the provided domain by fieldName.

    @param modelDomain domain whose image is returned
    @param extraDomain extra domain to use when counting records associated with field values
    @param fieldName the name of a field (type many2one or selection)
    @param enableCounters whether to set the key '__count' in image values
    @param onlyCounters whether to retrieve information on the model_domain image or only
                            counts based on model_domain and extra_domain. In the later case,
                            the counts are set whatever is enableCounters.
    @param limit integer, maximal number of values to fetch
    @param setLimit boolean, whether to use the provided limit (if any)
    @returns: a dict of the form
        {
            id: { 'id': id, 'displayName': displayName, ('__count': c,) },
            ...
        }
   */
  @api.model()
  async _searchpanelFieldImage(fieldName, kwargs: {} = {}) {
    const enableCounters = kwargs['enableCounters'];
    const onlyCounters = kwargs['onlyCounters'];
    const extraDomain = kwargs['extraDomain'] ?? [];
    const noExtra = isTrueDomain(extraDomain);
    const modelDomain = kwargs['modelDomain'] ?? [];
    const countDomain = AND([modelDomain, extraDomain]);

    const limit = kwargs['limit'];
    const setLimit = kwargs['setLimit'];

    if (onlyCounters) {
      return this._searchpanelDomainImage(fieldName, countDomain, true);
    }

    const modelDomainImage = await this._searchpanelDomainImage(fieldName, modelDomain, enableCounters && noExtra, setLimit && limit);
    if (enableCounters && !noExtra) {
      const countDomainImage = await this._searchpanelDomainImage(fieldName, countDomain, true);
      for (const [id, values] of Object.entries(modelDomainImage)) {
        const element = countDomainImage[id];
        values['__count'] = element ? element['__count'] : 0;
      }
    }

    return modelDomainImage;
  }

  /**
   * Return the values in the image of the provided domain by fieldName.

    @param domain domain whose image is returned
    @param fieldName the name of a field (type many2one or selection)
    @param setCount whether to set the key '__count' in image values. Default is false.
    @param limit integer, maximal number of values to fetch. Default is false.
    @returns: a dict of the form
        {
            id: { 'id': id, 'displayName': displayName, ('__count': c,) },
            ...
        }
   */
  @api.model()
  async _searchpanelDomainImage(fieldName, domain, setCount, limit?: any) {
    const field = this._fields[fieldName];
    let groupIdName;
    if (field.type === 'many2one') {
      groupIdName = (value) => {
        return value;
      }
    }
    else {
      // field type is selection: see doc above
      const desc = (await this.fieldsGet([fieldName]))[fieldName];
      const fieldNameSelection = Dict.from(desc['selection']);

      groupIdName = (value) => {
        return [value, fieldNameSelection[value]];
      }
    }

    domain = AND([
      domain,
      [[fieldName, '!=', false]],
    ])
    const groups = await this.readGroup(domain, [fieldName], [fieldName], { limit: limit });

    const domainImage = new Dict();
    for (const group of groups) {
      const [id, displayName] = groupIdName(group[fieldName]);
      const values = {
        'id': id,
        'displayName': displayName,
      }
      if (setCount) {
        values['__count'] = parseInt(group[fieldName + '_count']);
      }
      domainImage[id] = values;
    }
    return domainImage;
  }

  /**
   * Modify in place values_range to transform the (local) counts
    into global counts (local count + children local counts)
    in case a parent field parent_name has been set on the range values.
    Note that we save the initial (local) counts into an auxiliary dict
    before they could be changed in the for loop below.

    @param valuesRange dict of the form
        {
            id: { 'id': id, '__count': c, parent_name: parentId, ... }
            ...
        }
    @param parentName string, indicates which key determines the parent
   */
  @api.model()
  async _searchpanelGlobalCounters(valuesRange, parentName) {
    const localCounters = new LazyMapping((id) => valuesRange[id]['__count']);

    for (const id in valuesRange) {
      const values = valuesRange[id];
      // here count is the initial value = local count set on values
      const count = localCounters[id];
      if (count) {
        let parentId = values[parentName]
        while (parentId) {
          const values = valuesRange[parentId]
          localCounters[parentId]
          values['__count'] += count
          parentId = values[parentName]
        }
      }
    }
  }

  /**
   * Filter the provided list of records to ensure the following properties of
    the resulting sublist:
        1) it is closed for the parent relation
        2) every record in it is an ancestor of a record with id in ids
            (if ids = records.ids, that condition is automatically satisfied)
        3) it is maximal among other sublists with properties 1 and 2.

    @param records the list of records to filter, the records must have the form
                    { 'id': id, parent_name: false or (id, displayName),... }
    @param parentName string, indicates which key determines the parent
    @param ids list of record ids
    @returns the sublist of records with the above properties
   */
  @api.model()
  async _searchpanelSanitizedParentHierarchy(records, parentName, ids) {
    function getParentId(record) {
      const value = record[parentName]
      return value && value[0];
    }

    const allowedRecords = {}
    for (const record of records) {
      allowedRecords[record['id']] = record;
    }
    const recordsToKeep = {}
    for (const id of ids) {
      let recordId = id;
      const ancestorChain = {};
      let chainIsFullyIncluded = true;
      while (chainIsFullyIncluded && recordId) {
        const knownStatus = recordsToKeep[recordId];
        if (knownStatus != null) {
          // the record and its known ancestors have already been considered
          chainIsFullyIncluded = knownStatus;
          break;
        }
        const record = allowedRecords[recordId];
        if (bool(record)) {
          ancestorChain[recordId] = record;
          recordId = getParentId(record);
        }
        else {
          chainIsFullyIncluded = false;
        }
      }
      for (const [id, record] of Object.entries(ancestorChain)) {
        recordsToKeep[id] = chainIsFullyIncluded;
      }
    }
    // we keep initial order
    const result = [];
    for (const rec of records) {
      if (recordsToKeep[rec['id']]) {
        result.push(rec);
      }
    }
    return result;
  }

  /**
   * Return the values of a field of type selection possibly enriched
    with counts of associated records in domain.

    @param enableCounters whether to set the key '__count' on values returned.
                                Default is false.
    @param expand whether to return the full range of values for the selection
                    field or only the field image values. Default is false.
    @param fieldName the name of a field of type selection
    @param modelDomain domain used to determine the field image values and counts.
                            Default is [].
    @returns a list of dicts of the form
            { 'id': id, 'displayName': displayName, ('__count': c,) }
        with key '__count' set if enableCounters is true
   */
  @api.model()
  async _searchpanelSelectionRange(fieldName, kwargs: {} = {}) {
    const enableCounters = kwargs['enableCounters'];
    const expand = kwargs['expand'];

    let domainImage;
    if (enableCounters ?? !expand) {
      domainImage = await this._searchpanelFieldImage(fieldName, { expand: expand, ...kwargs });
    }

    if (!expand) {
      return Object.values(domainImage);
    }

    const selection = (await this.fieldsGet([fieldName]))[fieldName]['selection'];

    const selectionRange = [];
    for (const [value, label] of selection) {
      const values = {
        'id': value,
        'displayName': label,
      }
      if (enableCounters) {
        const imageElement = domainImage[value];
        values['__count'] = imageElement ? imageElement['__count'] : 0
      }
      selectionRange.push(values);
    }
    return selectionRange;
  }

  /**
   * Return possible values of the field fieldName (case select="one"),
    possibly with counters, and the parent field (if any and required)
    used to hierarchize them.

    @param fieldName the name of a field;
        of type many2one or selection.
    @param categoryDomain domain generated by categories. Default is [].
    @param comodelDomain domain of field values (if relational). Default is [].
    @param enableCounters whether to count records by value. Default is false.
    @param expand whether to return the full range of field values in comodelDomain
                    or only the field image values (possibly filtered and/or completed
                    with parents if hierarchize is set). Default is false.
    @param filterDomain domain generated by filters. Default is [].
    @param hierarchize determines if the categories must be displayed hierarchically
                        (if possible). If set to true and _parent_name is set on the
                        comodel field, the information necessary for the hierarchization will
                        be returned. Default is true.
    @param limit integer, maximal number of values to fetch. Default is None.
    @param searchDomain base domain of search. Default is [].
                    with parents if hierarchize is set)
    @returns: {
        'parentField': parent field on the comodel of field, or false
        'values': array of dictionaries containing some info on the records
                    available on the comodel of the field 'fieldName'.
                    The display name, the __count (how many records with that value)
                    and possibly parentField are fetched.
    }
    or an object with an error message when limit is defined and is reached.
   */
  @api.model()
  async searchpanelSelectRange(fieldName, kwargs) {
    const field = this._fields[fieldName];
    const supportedTypes = ['many2one', 'selection'];
    if (!supportedTypes.includes(field.type)) {
      const fieldTtype = this.env.models["ir.model.fields"]._fields["ttype"];
      const types = new Dict(await fieldTtype._descriptionSelection(fieldTtype, this.env));
      throw new UserError(_f(
        await this._t('Only types {supportedTypes} are supported for category (found type {fieldType})'),
        { supportedTypes: supportedTypes.map(t => types[t]).join(", "), fieldType: types[field.type] },
      ))
    }
    const modelDomain = kwargs['searchDomain'] ?? [];
    const extraDomain = AND([
      kwargs['categoryDomain'] ?? [],
      kwargs['filterDomain'] ?? [],
    ])

    if (field.type === 'selection') {
      return {
        'parentField': false,
        'values': await this._searchpanelSelectionRange(fieldName, { modelDomain: modelDomain, extraDomain: extraDomain, ...kwargs }),
      }
    }

    const Comodel = await this.env.items(field.comodelName).withContext({ hierarchicalNaming: false });
    const fieldNames = ['displayName'];
    let hierarchize = kwargs['hierarchize'] ?? true;
    let parentName, getParentId;
    if (hierarchize && Comodel.cls._parentName in Comodel._fields) {
      parentName = Comodel.cls._parentName;
      fieldNames.push(parentName)

      getParentId = (record) => {
        const value = record[parentName];
        return value && value[0];
      }
    }
    else {
      hierarchize = false;
    }

    let comodelDomain = kwargs['comodelDomain'] ?? [];
    const enableCounters = kwargs['enableCounters'];
    const expand = kwargs['expand'];
    const limit = kwargs['limit'];

    let domainImage;
    if (enableCounters || !expand) {
      domainImage = await this._searchpanelFieldImage(fieldName,
        {
          modelDomain: modelDomain, extraDomain: extraDomain,
          onlyCounters: expand, setLimit: limit && !(expand || hierarchize || comodelDomain), ...kwargs
        }
      )
    }
    if (!(expand || hierarchize || comodelDomain)) {
      const values = Object.values(domainImage);
      if (limit && len(values) == limit) {
        return { 'errorMsg': String(SEARCH_PANEL_ERROR_MESSAGE) };
      }
      return {
        'parentField': parentName,
        'values': values,
      }
    }
    let imageElementIds;
    if (!expand) {
      imageElementIds = Object.keys(domainImage).map(id => parseInt(id));
      let condition;
      if (hierarchize) {
        condition = [['id', 'parentOf', imageElementIds]];
      }
      else {
        condition = [['id', 'in', imageElementIds]];
      }
      comodelDomain = AND([comodelDomain, condition]);
    }

    let comodelRecords = await Comodel.searchRead(comodelDomain, fieldNames, { limit });
    if (hierarchize) {
      const ids = expand ? comodelRecords.map(rec => parseInt(rec['id'])) : imageElementIds;
      comodelRecords = await this._searchpanelSanitizedParentHierarchy(comodelRecords, parentName, ids);
    }
    if (limit && len(comodelRecords) == limit) {
      return { 'errorMsg': String(SEARCH_PANEL_ERROR_MESSAGE) }
    }

    const fieldRange = {}
    for (const record of comodelRecords) {
      const recordId = record['id']
      const values = {
        'id': recordId,
        'displayName': record['displayName'],
      }
      if (hierarchize) {
        values[parentName] = getParentId(record);
      }
      if (enableCounters) {
        const imageElement = domainImage[recordId];
        values['__count'] = imageElement ? imageElement['__count'] : 0
      }
      fieldRange[recordId] = values;
    }
    if (hierarchize && enableCounters) {
      await this._searchpanelGlobalCounters(fieldRange, parentName)
    }

    return {
      'parentField': parentName,
      'values': Object.values(fieldRange),
    }
  }

  /**
   *     Return possible values of the field fieldName (case select="multi"),
    possibly with counters and groups.

    @param fieldName the name of a filter field;
        possible types are many2one, many2many, selection.
    @param categoryDomain domain generated by categories. Default is [].
    @param comodelDomain domain of field values (if relational)
                            (this parameter is used in _search_panel_range). Default is [].
    @param enableCounters whether to count records by value. Default is false.
    @param expand whether to return the full range of field values in comodelDomain
                    or only the field image values. Default is false.
    @param filterDomain domain generated by filters. Default is [].
    @param groupby extra field to read on comodel, to group comodel records
    @param groupDomain dict, one domain for each activated group
                            for the groupby (if any). Those domains are
                            used to fech accurate counters for values in each group.
                            Default is [] (many2one case) or None.
    @param limit integer, maximal number of values to fetch. Default is None.
    @param searchDomain base domain of search. Default is [].
    @returns: {
        'values': a list of possible values, each being a dict with keys
            'id' (value),
            'label' (value label),
            '__count' (how many records with that value),
            'groupId' (value of group), set if a groupby has been provided,
            'groupName' (label of group), set if a groupby has been provided
    }
    or an object with an error message when limit is defined and reached.
   */
  @api.model()
  async searchpanelSelectMultiRange(fieldName, kwargs) {
    const field = this._fields[fieldName];
    const supportedTypes = ['many2one', 'many2many', 'selection'];
    if (!supportedTypes.includes(field.type)) {
      throw new UserError(_f(
        await this._t('Only types {supportedTypes} are supported for filter (found type {fieldType})'),
        { supportedTypes: supportedTypes, fieldType: field.type }
      ));
    }

    const modelDomain = kwargs['searchDomain'] ?? [];
    let extraDomain = AND([
      kwargs['categoryDomain'] ?? [],
      kwargs['filterDomain'] ?? [],
    ])

    if (field.type === 'selection') {
      return {
        'values': await this._searchpanelSelectionRange(fieldName, { modelDomain: modelDomain, extraDomain: extraDomain, ...kwargs })
      };
    }
    const Comodel = await this.env.items(field.comodelName).withContext({ hierarchicalNaming: false });
    const fieldNames = ['displayName'];
    const groupby = kwargs['groupby'];
    const limit = kwargs['limit'];
    let groupIdName;
    if (groupby) {
      const groupbyField = Comodel._fields[groupby];

      fieldNames.push(groupby);

      if (groupbyField.type === 'many2one') {
        groupIdName = async (value) => {
          return value ?? [false, await this._t("Not Set")];
        }
      }

      else if (groupbyField.type === 'selection') {
        const desc = (await Comodel.fieldsGet([groupby]))[groupby];
        const groupbySelection = new Map<any, any>(desc['selection']);
        groupbySelection.set(false, await this._t("Not Set"));

        groupIdName = async (value) => {
          return [value, groupbySelection.get(value)];
        }
      }
      else {
        groupIdName = async (value) => {
          return value ? [value, value] : [false, await this._t("Not Set")];
        }
      }
    }
    let comodelDomain = kwargs['comodelDomain'] ?? [];
    const enableCounters = kwargs['enableCounters'];
    const expand = kwargs['expand'];

    if (field.type === 'many2many') {
      const comodelRecords = await Comodel.searchRead(comodelDomain, fieldNames, { limit });
      if (expand && limit && len(comodelRecords) === limit) {
        return { 'errorMsg': String(SEARCH_PANEL_ERROR_MESSAGE) }
      }

      const groupDomain = kwargs['groupDomain'];
      const fieldRange = [];
      let groupId, groupName;
      for (const record of comodelRecords) {
        const recordId = record['id']
        const values = {
          'id': recordId,
          'displayName': await record['displayName'],
        }

        let count, inImage;
        if (groupby) {
          [groupId, groupName] = await groupIdName(await record[groupby]);
          values['groupId'] = groupId;
          values['groupName'] = groupName;
        }
        if (enableCounters || !expand) {
          const searchDomain = AND([
            modelDomain,
            [[fieldName, 'in', recordId]],
          ])
          let localExtraDomain = extraDomain;
          if (groupby && groupDomain) {
            localExtraDomain = AND([
              localExtraDomain,
              groupDomain.set(stringify(groupId), []),
            ])
          }
          const searchCountDomain = AND([
            searchDomain,
            localExtraDomain
          ])

          if (enableCounters) {
            count = await this.searchCount(searchCountDomain);
          }
          if (!expand) {
            if (enableCounters && isTrueDomain(localExtraDomain)) {
              inImage = count;
            }
            else {
              inImage = await this.search(searchDomain, { limit: 1 });
            }
          }
        }
        if (expand || inImage) {
          if (enableCounters) {
            values['__count'] = count;
          }
          fieldRange.push(values);
        }
      }
      if (!expand && limit && len(fieldRange) == limit) {
        return { 'errorMsg': String(SEARCH_PANEL_ERROR_MESSAGE) }
      }

      return { 'values': fieldRange, }
    }
    if (field.type === 'many2one') {
      let domainImage;
      if (enableCounters || !expand) {
        extraDomain = AND([
          extraDomain,
          kwargs['groupDomain'] ?? [],
        ])
        domainImage = await this._searchpanelFieldImage(fieldName,
          {
            modelDomain: modelDomain, extraDomain: extraDomain,
            onlyCounters: expand,
            setLimit: limit && !(expand || groupby || comodelDomain), ...kwargs
          }
        )
      }
      if (!(expand || groupby || comodelDomain)) {
        const values = Object.values(domainImage);
        if (limit && len(values) == limit) {
          return { 'errorMsg': String(SEARCH_PANEL_ERROR_MESSAGE) }
        }
        return { 'values': values }
      }
      if (!expand) {
        const imageElementIds = Object.values(domainImage);
        comodelDomain = AND([
          comodelDomain,
          [['id', 'in', imageElementIds]],
        ])
      }
      let comodelRecords = await Comodel.searchRead(comodelDomain, fieldNames, { limit });
      if (limit && len(comodelRecords) == limit) {
        return { 'errorMsg': String(SEARCH_PANEL_ERROR_MESSAGE) }
      }
      const fieldRange = [];
      for (const record of comodelRecords) {
        const recordId = record['id']
        const values = {
          'id': recordId,
          'displayName': await record['displayName'],
        }

        if (groupby) {
          const [groupId, groupName] = await groupIdName(await record[groupby]);
          values['groupId'] = groupId;
          values['groupName'] = groupName;
        }
        if (enableCounters) {
          const imageElement = domainImage[recordId];
          values['__count'] = imageElement ? imageElement['__count'] : 0;
        }
        fieldRange.push(values);
      }
      return { 'values': fieldRange, }
    }
  }
}

@MetaModel.define()
class ResCompany extends Model {
  static _module = module;
  static _parents = 'res.company';

  @api.modelCreateMulti()
  async create(valsList) {
    const companies = await _super(ResCompany, this).create(valsList);
    const styleFields = ['externalReportLayoutId', 'font', 'primaryColor', 'secondaryColor'];
    if (valsList.some(values => _.intersection(styleFields, Object.keys(values)).length)) {
      // any(not styleFields.isdisjoint(values) for values in valsList):
      await this._updateAssetStyle();
    }
    return companies;
  }

  async write(values) {
    const res = await _super(ResCompany, this).write(values);
    const styleFields = ['externalReportLayoutId', 'font', 'primaryColor', 'secondaryColor'];
    if (!_.intersection(styleFields, Object.keys(values)).length) {
      await this._updateAssetStyle();
    }
    return res;
  }

  async _getAssetStyleB64() {
    const templateStyle = await this.env.ref('web.stylesCompanyReport', false);
    if (!bool(templateStyle)) {
      return '';
    }
    // One bundle for everyone, so this method
    // necessarily updates the style for every company at once
    const companyIds = await (await this.sudo()).search([]);
    const companyStyles = await templateStyle._render({
      'companyIds': companyIds,
    })
    return b64encode(Buffer.from(companyStyles));
  }

  async _updateAssetStyle() {
    let assetAttachment = await this.env.ref('web.assetStylesCompanyReport', false);
    if (!bool(assetAttachment)) {
      return;
    }
    assetAttachment = await assetAttachment.sudo();
    const b64Val = await this._getAssetStyleB64();
    if (!equal(b64Val, await assetAttachment.datas)) {
      await assetAttachment.write({ 'datas': b64Val });
    }
  }
}

function _lt(str: string) {
  return str;
}

class LazyMapping extends DefaultDict2 {
}

