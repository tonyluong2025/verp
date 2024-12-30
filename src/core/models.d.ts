import { Meta } from "./api";
import { Environment } from './api/api';
import { Field, Fields } from './fields';
import { DefaultDict, Dict } from './helper';
import { Registry } from "./modules/registry";
import { Query } from './osv/query';
import { Cursor } from "./sql_db";

declare type IdType = number | string | NewId;

declare const PREFETCH_MAX: number;
declare const VALID_AGGREGATE_FUNCTIONS: string[];

declare const LOG_ACCESS_COLUMNS: string[];
declare const MAGIC_COLUMNS: string[];

/**
 * Yields atoms filtered by specified type (or type tuple), traverses
    through standard containers (non-string mappings or sequences) *unless*
    they're selected by the type filter
 * @param val 
 * @param type 
 * @returns 
 */
declare function traverseContainers(val, type): Generator<any, any, boolean>;

/**
 * Check if the given name is a valid model name.

  The _name attribute in osv and osv_memory object is subject to
  some restrictions. This function returns true or false whether
  the given name is allowed or not.

  The same restriction should apply to both osv and osv_memory
  objects for consistency.
 * @param name 
 */
declare function checkObjectName(name: string): boolean;

/**
 * Raise an ``AccessError`` if ``name`` is a private method name.
 * @param name 
 */
declare function checkMethodName(name: string): void;

// type IdType
/**
 * Return an iterator over the origin ids corresponding to ``ids``.
  Actual ids are returned as is, and ids without origin are not returned.
 * @param ids 
 * @returns 
 */
declare function originIds(ids: IdType[]): any[];

/**
 * Return an iterator of unique ids from the concatenation of ``[id0]`` and
  ``ids``, and of the same kind (all real or all new).
  * @param id0 
  * @param ids 
  */
declare function expandIds(id0, ids): Generator<number, string, boolean>;

declare function findProperty(cls: any, key: string): any;

declare function getModule(modul: any): string;

declare function isDefinitionClass(cls: any): boolean;

declare function isRegistryClass(cls: any): boolean;

/**
 * Fixes the id fields in import and exports, and splits field paths on '/'.
    @param str fieldname: name of the field to import/declare
    @returns split field name
    :rtype: list of str
 * @param fieldname 
 * @returns 
 */
declare function fixImportExportIdPaths(fieldname: string): string;

/**
 * Evaluate self.nameGet() lazily.
 * @returns 
 */
declare function lazyNameGet(self: any): Promise<any[]>;
/**
 * Step up in the chain of bases to find out the method. JUST CALL IN class with _parents
 * @param cls 
 * @param obj 
 * @returns 
 */
declare function _super(cls: any, obj: any, bypass?: boolean): any;

declare function isSubclass(obj: any, base: any): boolean;

declare class MetaModel extends Meta {
  static moduleToModels: DefaultDict<any, any>;

  static define(name?: string): ClassDecorator;

  static init(cls: any, attrs: {}): void;

  static build(base: Function, name?: string): Function;

  static copyProperties(cls: any, bases: any[]): void;

  static copyAtributes(cls: any, bases: any[]): void;

  static setPrototype(target: any, source: any): void;
}

declare function newId(id: Number): NewId;

declare class NewId extends Number {
  private _uuid: string;
  origin: number;
  ref: number;

  constructor(origin?: number, ref?: number);

  valueOf(): number;

  _bool(): boolean;

  toString(): string;
}

declare class RecordCache {
  private _record: any;

  constructor(record: any);

  /**
   * Iterate over the field names with a cached value.
   */
  [Symbol.iterator](): IterableIterator<number>;

  /**
   * Return the number of fields with a cached value.
   * @returns 
   */
  get length(): number;

  items(): [string, Field][];

  get(fname): any;

  clear(): void;

  includes(field: Field): boolean;

  contains(field: Field): boolean;
}

declare type ModelRecords = BaseModel & {
  cls: Function,
  env: Environment,
  pool: Registry,
  _fields: Dict<Fields>,
  _ids: Number[],
  _prefetchIds: Number[],

  id: number,
  updatedAt: any,
  createdAt: any
}

declare class BaseModel extends Function {
  protected static _auto: boolean;
  protected static _register: boolean;           // registry visibility
  protected static _abstract: boolean;
  protected static _transient: boolean;          // not transient

  protected static _name: string;                // the model name (in dot-notation, module namespace)
  protected static _description: string;         // the model's informal name
  protected static _moduleName: string;              // the model's module (in the Verp sense)
  protected static _custom: boolean;              // should be true for custom models only

  protected static _parents: string[] | string;
  protected static _inherits: Record<string, string>;

  protected static _table: string;               // SQL table name used by model if :attr:`_auto`
  protected static _tableQuery: Function | string;          // SQL expression of the table's content (optional)
  protected static _sequence: string;            // SQL sequence to use for ID field
  protected static _sqlConstraints: string[][];        // SQL constraints [[name, sql_def, message]]

  protected static _recName: string;             // field to use for labeling records, default: ``name``
  protected static _order: string;               // default order field for searching results
  protected static _parentName: string;    // the many2one field used as parent field
  protected static _parentStore: boolean;

  protected static _activeName: string;          // field to use for active records
  protected static _dateName: string;          // field to use for default calendar view
  protected static _foldName: string;          // field to determine folded groups in kanban views

  protected static _needaction: boolean;         // whether the model supports "need actions" (Old API)
  protected static _translate: boolean;           // false disables translations declare for this model (Old API)
  protected static _checkCompanyAuto: boolean;

  protected static _depends: Dict<any>;

  protected static _modelSeq: string;

  protected static _defination: string;

  static CONCURRENCY_CHECK_FIELD: string;
  static _transientMaxCount: string;
  static _transientMaxHours: string;

  env: Environment;
  pool: Registry;
  _ids: number[];
  _prefetchIds: number[];
  _name: string;

  static toString(): string;

  /**
   * Method Resolution Order filtered by type
   */
  static mro(type: string): any[];

  /**
   * Method Resolution Order
   */
  static _mro(): Function[];

  static buildModel(baseClass: any, pool: Registry, cr: Cursor): any;

  protected static _buildModelCheckBase(virtualClass: any, baseClass: any): void;

  /**
   * Check whether "modelClass" can inherit from parentClass
   * @param modelClass 
   * @param cls 
   * @param parentClass 
   */
  protected static _buildModelCheckParent(myCls: any, cls: any, parentClass: any): void;

  protected static _initConstraintsOnchanges(): void;
  protected static _buildModelAttributes(pool: Registry): void;

  static _constraintMethods(model): Function[];
  /**
   * Return a list of methods implementing checks before unlinking.
   */
  static _ondeleteMethods(): Function[];

  /**
   * Return a dictionary mapping field names to onchange methods.
   */
  static _onchangeMethods(): Dict<Function[]>;

  protected _getProxy(): ProxyConstructor;

  /**
   *  Clear the caches
    This clears the caches associated to methods decorated with
    ``tools.ormcache`` or ``tools.ormcacheMulti``.
   */
  clearCaches(): void;

  _isAnOrdinaryTable(): Promise<boolean>;

  _prepareSetup(): void;

  __init__(pool, cr): void;

  _setupBase(): Promise<void>;

  _setupFields(): void;

  /**
   * Remove the field with the given ``name`` from the model. This method should only be used for manual fields.
   * @param name 
   * @returns 
   */
  _popField(name): Field;

  /**
   * Setup recomputation triggers, and complete the model setup.
   */
  _setupComplete(): void;

  /**
   * stuff to do right after the registry is built
   */
  _registerHook(): Promise<void>;

  /**
   * Clean up what `~._registerHook` has done.
   */
  _unregisterHook(): Promise<void>;

  _inheritsCheck(): Promise<void>;

  protected _addInheritedFields(): void;

  protected _validFieldParameter(field: Field, name: string): boolean;

  protected _addField(name: string, field: Field): void;

  _computeConcurrencyField(): Promise<void>;

  /**
   * Invoke the constraint methods for which at least one field name is
    in ``fieldNames`` and none is in ``excludedNames``.
   * @param fieldNames 
   * @param excludedNames 
   */
  _validateFields(fieldNames: string[], excludedNames?: string[]): Promise<void>;

  viewHeaderGet(viewId: any, viewType: string): Promise<boolean>;

  userHasGroups(groups: string): Promise<boolean>;

  checkAccessRights(operation: string | { operation: string, raiseException?: boolean }, raiseException?: boolean): Promise<boolean>;

  /**
   * Verifies that the operation given by ``operation`` is allowed for the current user according to ir.rules.
    @param operation: one of ``write``, ``unlink``
    @throw UserError: * if current ir.rules do not permit this operation.
    @returns None if the operation is allowed
   * @param operation 
   */
  checkAccessRule(operation: string): Promise<void>;

  /**
   * Return the subset of ``this`` for which ``operation`` is allowed.
   * @param operation 
   * @returns 
   */
  _filterAccessRules(operation: string): Promise<any>;

  _filterAccessRulesSystem(operation: string): Promise<any[]>;

  checkFieldAccessRights(operation: string, fields: any[]): Promise<boolean | string[]>;

  new(values?: any, options?: { origin?: any, ref?: any }): Promise<any>;

  /**
   * Recursively copy the translations from original to new record

    @param old: the original record
    @param new: the new record (copy of the original one)
    @param excluded: a container of user-provided field names
   * @param old 
   * @param 
   * @param excluded 
   */
  copyTranslations(newObj: any, excluded?: {}): Promise<void>;

  /**
   * copy(defaultValue=undefined)

    Duplicate record ``this`` updating it with default values

    @param dict default: dictionary of field values to override in the
            original values of the copied record, e.g: ``{'fieldName': overriddenValue, ...}``
    @returns new record

   */
  copy(defaultValue?: Object): Promise<any>;

  /**
   * Copy given record's data with all its fields values

    @param default: field values to override in the original values of the copied record
    @returns list with a dictionary containing all the field values
   * @param defaultValue 
   * @returns 
   */
  copyData(defaultValue?: {}): Promise<void | {}[]>;

  /**
   * Returns a list of dictionaries mapping field names to their values,
        with one dictionary per record that exists.

        The output format is similar to the one expected from the `read` method.

        The current method is different from `read` because it retrieves its
        values from the cache without doing a query when it is avoidable.
   * @param fnames 
   * @param load 
   * @returns [{...}, {...}]
   */
  _readFormat(fnames: string[], load?: string): Promise<{}[]>;

  /**
   * Read the given fields of the records in ``this`` from the database,
    and store them in cache. Access errors are also stored in cache.
    Skip fields that are not stored.

    @param fieldNames list of column names of model ``this``; all those
        fields are guaranteed to be read
    @param inheritedFieldNames list of column names from parent
        models; some of those fields may not be read
   */
  _read(fields: string[]): Promise<void | {}[]>;

  /**
   * read([fields])
    Reads the requested fields for the records in ``this``, low-level/RPC method. In JS code, prefer method `~.browse`.
   * @param fields list of field names to return (default is all fields)
   * @param load 
   * @returns a list of dictionaries mapping field names to their values, with one dictionary per record
   * @raise AccessError: if user has no read rights on some of the given records
   */
  read(fields?: string[], load?: string): Promise<{}[]>;

  readOne(fields?: string[], load?: string): Promise<any>;

  readGroup(domain, fields, groupby, options?: { offset?: number, limit?: number, orderby?: string, lazy?: boolean }): Promise<{}[]>;

  _readGroupRaw(domain, fields, groupby, options?: { offset?: number, limit?: number, orderby?: string, lazy?: boolean }): Promise<{}[]>;

  _readGroupExpandFull(groups, domain, order): Promise<any>;

  _readGroupResolveMany2xFields(data: any[], fields: any[]): Promise<void>;

  /**
   * Helper method for filling date/datetime 'holes' in a result set.

        We are in a use case where data are grouped by a date field (typically
        months but it could be any other interval) and displayed in a chart.

        Assume we group records by month, and we only have data for June,
        September and December. By default, plotting the result gives something
        like:
                                                ___
                                      ___      |   |
                                     |   | ___ |   |
                                     |___||___||___|
                                      Jun  Sep  Dec

        The problem is that December data immediately follow September data,
        which is misleading for the user. Adding explicit zeroes for missing
        data gives something like:
                                                           ___
                             ___                          |   |
                            |   |           ___           |   |
                            |___| ___  ___ |___| ___  ___ |___|
                             Jun  Jul  Aug  Sep  Oct  Nov  Dec

        To customize this output, the context key "fillTemporal" can be used
        under its dictionary format, which has 3 attributes : fillFrom,
        fillTo, minGroups (see params of this function)

        Fill between bounds:
        Using either `fillFrom` and/or `fillTo` attributes, we can further
        specify that at least a certain date range should be returned as
        contiguous groups. Any group outside those bounds will not be removed,
        but the filling will only occur between the specified bounds. When not
        specified, existing groups will be used as bounds, if applicable.
        By specifying such bounds, we can get empty groups before/after any
        group with data.

        If we want to fill groups only between August (fillFrom)
        and October (fillTo):
                                                     ___
                                 ___                |   |
                                |   |      ___      |   |
                                |___| ___ |___| ___ |___|
                                 Jun  Aug  Sep  Oct  Dec

        We still get June and December. To filter them out, we should match
        `fillFrom` and `fillTo` with the domain e.g. ['&',
            ['dateField', '>=', 'YYYY-08-01'],
            ['dateField', '<', 'YYYY-11-01']]:
                                         ___
                                    ___ |___| ___
                                    Aug  Sep  Oct

        Minimal filling amount:
        Using `minGroups`, we can specify that we want at least that amount of
        contiguous groups. This amount is guaranteed to be provided from
        `fillFrom` if specified, or from the lowest existing group otherwise.
        This amount is not restricted by `fillTo`. If there is an existing
        group before `fillFrom`, `fillFrom` is still used as the starting
        group for min_groups, because the filling does not apply on that
        existing group. If neither `fillFrom` nor `fillTo` is specified, and
        there is no existing group, no group will be returned.

        If we set minGroups = 4:
                                         ___
                                    ___ |___| ___ ___
                                    Aug  Sep  Oct Nov

        @param data the data containing groups
        @param groupby name of the first group by
        @param aggregatedFields list of aggregated fields in the query
        @param fillFrom (inclusive) string representation of a
            date/datetime, start bound of the fillTemporal range
            formats: date -> %Y-%m-%d, datetime -> %Y-%m-%d %H:%M:%S
        @param fillTo (inclusive) string representation of a
            date/datetime, end bound of the fillTemporal range
            formats: date -> %Y-%m-%d, datetime -> %Y-%m-%d %H:%M:%S
        @param minGroups minimal amount of required groups for the
            fillTemporal range (should be >= 1)
        :rtype: list
        @returns list
   * @param {*} data 
   * @param {*} groupby 
   * @param {*} aggregatedFields 
   * @param {*} annotatedGroupbys 
   * @param {*} fillTemporal 
   */
  _readGroupFillTemporal(data: any[], groupby: any, aggregatedFields: any[], annotatedGroupbys: any[], fillTemporal: any): Promise<any>;

  _readGroupFormatResult(data: any[], annotatedGroupbys: any[], groupby: any, domain: any[]): Promise<{}>;

  _readGroupFillResults(domain, groupby: string, remainingGroupbys, aggregatedFields, countField, readGroupResult, readGroupOrder?: any): Promise<any[]>;

  _readGroupPrepareData(key: string, value?: any, groupbyDict?: {}): Promise<any>;

  /**
   * Prepares the GROUP BY and ORDER BY terms for the readGroup method. Adds the missing JOIN clause
    to the query if order should be computed against m2o field.
    @param orderby the orderby definition in the form "{field} {order}"
    @param aggregatedFields list of aggregated fields in the query
    @param annotatedGroupbys list of dictionaries returned by _read_group_process_groupby
            These dictionaries contains the qualified name of each groupby
            (fully qualified SQL name for the corresponding field),
            and the (non raw) field name.
    @param query the query under construction
    @returns [groupbyTerms, orderbyTerms]
   */
  _readGroupPrepare(orderby: any, aggregatedFields: any[], annotatedGroupbys: any[], query: any): Promise<[any, any]>;

  /**
   * Helper method to collect important information about groupbys: raw field name, type, time information, qualified name, ...
   */
  _readGroupProcessGroupby(gb: any, query: any): Promise<any>;

  _create(dataList: any[]): Promise<any>;

  create(valsList: any): Promise<any>;

  _write(values: Dict<any>): Promise<any>;

  /**
   * write(vals)

    Updates all records in the current set with the provided values.

    @param dict vals: fields to update and the value to set on them e.g::

            {'foo': 1, 'bar': "Qux"}

        will set the field ``foo`` to ``1`` and the field ``bar`` to
        ``"Qux"`` if those are valid (otherwise it will trigger an error).

    @throw AccessError * if user has no write rights on the requested object
                        * if user tries to bypass access rules for write on the requested object
    @throw ValidationError if user tries to enter invalid value for a field that is not in selection
    @throw UserError if a loop would be created in a hierarchy of objects a result of the operation (such as setting an object as its own parent)

    * For numeric fields (class `~verp.fields.Integer`,
      class `~verp.fields.Float`) the value should be of the
      corresponding type
    * For class `~verp.fields.Boolean`, the value should be a
      class `boolean`
    * For class `~verp.fields.Selection`, the value should match the
      selection values (generally class `string`, sometimes
      class `number`)
    * For class `~verp.fields.Many2one`, the value should be the
      database identifier of the record to set
    * Other non-relational fields use a string for value

      .. danger::

          for historical and compatibility reasons,
          class `~verp.fields.Date` and
          class `~verp.fields.Datetime` fields use strings as values
          (written and read) rather than class `~Date` . These date strings are
          UTC-only and formatted according to
          :const:`verp.tools.misc.DEFAULT_SERVER_DATE_FORMAT` and
          :const:`verp.tools.misc.DEFAULT_SERVER_DATETIME_FORMAT`
    * .. _openerp/models/relationals/format:

      The expected value of a class `~verp.fields.One2many` or
      class `~verp.fields.Many2many` relational field is a list of
      class `~verp.fields.Command` that manipulate the relation the
      implement. There are a total of 7 commands:
      method `~verp.fields.Command.create`,
      method `~verp.fields.Command.update`,
      method `~verp.fields.Command.delete`,
      method `~verp.fields.Command.unlink`,
      method `~verp.fields.Command.link`,
      method `~verp.fields.Command.clear`, and
      method `~verp.fields.Command.set`.
   */
  write(values: {}): Promise<any>

  /**
   * Deletes the records of the current set
    @throw AccessError * if user has no unlink rights on the requested object
                        * if user tries to bypass access rules for unlink on the requested object
    @throw UserError if the record is default property for other records
   */
  unlink(): Promise<boolean>;

  _computeFieldValue(field: Field): Promise<void>;

  /**
   * Compute parentPath field from scratch.
   * @returns 
   */
  _parentStoreCompute(): Promise<boolean>;

  /**
   * Return the records in ``this`` that must update their parent_path field. This must be called before updating the parent field.
   * @param vals 
   * @returns 
   */
  _parentStoreUpdatePrepare(vals: {}): Promise<any>;

  /**
   * Update the parent_path field of ``this``. 
   */
  _parentStoreUpdate(): Promise<void>;

  _parentStoreCreate(): Promise<void>;

  /**
   * Create a recordset instance.
   * @param env an environment
   * @param ids a tuple of record ids
   * @param prefetchIds a collection of record ids (for prefetching)
   */
  protected _browse(env: Environment, ids: any, prefetchIds: any): any;

  /**
   * browse([ids]) -> records

      Returns a recordset for the ids provided as parameter in the current
      environment.

          this.browse([7, 18, 12])
          res.partner(7, 18, 12)

      @param ids id(s), type number or number[] or null
      @returns recordset
   */
  browse(ids?: any): any;

  /**
   * Private implementation of search() method, allowing specifying the uid to use for the access right check.
    This is useful for example when filling in the selection list for a drop-down and avoiding access rights errors,
    by specifying ``access_rights_uid=1`` to bypass access rights check, but not ir.rules!
    This is ok at the security level because this method is private and not isCallable through XML-RPC.

    @param accessRightsUid optional user ID to use when checking access rights
                              (not for ir.rules, this is only for ir.model.access)
    @returns a list of record ids or an integer (if count is true)
   */
  _search(args: any, options?: { offset?: number, limit?: number, order?: string, count?: boolean, accessRightsUid?: boolean, isQuery?: boolean }): Promise<number | Query | any[]>;

  /**
   * search(args, {offset: 0, limit: null, order: null, count: false})

    Searches for records based on the ``args``
    ref `search domain <reference/orm/domains>`.

    @param args ref `A search domain <reference/orm/domains>`. Use an empty
                  list to match all records.
    @param offset number of results to ignore (default: none)
    @param limit maximum number of records to return (default: all)
    @param order sort string
    @param count if true, only counts and returns the number of matching records (default: false)
    @returns at most ``limit`` records matching the search criteria
    @throw AccessError * if user tries to bypass access rules for read on the requested object.
    */
  search(args, options?: { offset?: number, limit?: number, order?: string, count?: boolean, accessRightsUid?: boolean, debug?: boolean }): Promise<any>;

  searchCount(args): Promise<number>;

  /**
   * Perform a method `search` followed by a method `read`.

    @param domain Search domain, see ``args`` parameter in method `search`.
        Defaults to an empty domain that will match all records.
    @param fields List of fields to read, see ``fields`` parameter in method `read`.
        Defaults to all fields.
    @param offset Number of records to skip, see ``offset`` parameter in method `search`.
        Defaults to 0.
    @param limit Maximum number of records to return, see ``limit`` parameter in method `search`.
        Defaults to no limit.
    @param order Columns to sort result, see ``order`` parameter in method `search`.
        Defaults to no sort.
    @param options: All read keywords arguments used to call read(..., options) method
        E.g. you can use searchRead({..., load: ''}) in order to avoid computing nameGet
    @returns List of dictionaries containing the asked fields.
   */
  searchRead(domain?: any[], fields?: any[], options?: { offset?: any, limit?: any, order?: any }): Promise<{}[]>;

  /**
     * Inverse the value of the field ``(x_)active`` on the records in ``this``. 
     */
  toggleActive(): Promise<any>;

  /**
   * Set (x_)active=false on a recordset, by calling toggle_active to take the corresponding actions according to the model
   * @returns 
   */
  actionArchive(): Promise<any>;

  /**
   * Set (x_)active=true on a recordset, by calling toggle_active to take the corresponding actions according to the model
   * @returns 
   */
  actionUnarchive(): Promise<any>;

  /**
   * Compute the value of the `displayName` field.

      In general `displayName` is equal to calling `nameGet()[0][1]`.

      In that case, it is recommended to use `displayName` to uniformize the
      code and to potentially take advantage of prefetch when applicable.

      However some models might override this method. For them, the behavior
      might differ, and it is important to select which of `displayName` or
      `nameGet()[0][1]` to call depending on the desired result.
   */
  _computeDisplayName(): Promise<void>;

  /**
   * nameGet() -> [[id, label], ...]

    Returns a textual representation for the records in ``this``.
    By default this is the value of the ``displayName`` field.

    @returns list of pairs ``[id, textRepr]`` for each records
   */
  nameGet(): Promise<any[]>;

  /**
   * nameCreate(name) -> record
    Create a new record by calling method `~.create` with only one value
    provided: the display name of the new record.

    The new record will be initialized with any default values
    applicable to this model, or provided through the context. The usual
    behavior of method `~.create` applies.

    @param name display name of the record to create
    @returns the method `~.nameGet` pair value of the created record
   */
  nameCreate(name): Promise<boolean>;

  /**
   * nameSearch(name='', args=None, operator='ilike', limit=100) -> records

        Search for records that have a display name matching the given
        ``name`` pattern when compared with the given ``operator``, while also
        matching the optional search domain (``args``).

        This is used for example to provide suggestions based on a partial
        value for a relational field. Sometimes be seen as the inverse
        function of method `~.nameGet`, but it is not guaranteed to be.

        This method is equivalent to calling method `~.search` with a search
        domain based on ``displayName`` and then method `~.nameGet` on the
        result of the search.

        @param name the name pattern to match
        @param args optional search domain (see method `~.search` for
                          syntax), specifying further restrictions
        @param operator domain operator for matching ``name``, such as
                             ``'like'`` or ``'='``.
        @param limit optional max number of records to return
        @returns list of pairs ``(id, text_repr)`` for all matching records.
   */
  nameSearch(options?: { name?: string, args?: any[], operator?: string, limit?: number }): Promise<any>;

  /**
   * _nameSearch(name='', args=None, operator='ilike', limit=100, nameGetUid=None) -> ids

      Private implementation of nameSearch, allows passing a dedicated user
      for the nameGet part to solve some access rights issues.
   * @param name 
   * @param args 
   * @param operator 
   * @param options 
   */
  _nameSearch(name: string, args?: any[], operator?: string, options?: { limit?: number, nameGetUid?: boolean }): Promise<any>;

  _addMissingDefaultValues(values): Promise<Dict<any>>;

  /**
   * Return records to prefetch that have no value in cache for ``field``
    (class `Field` instance), including ``this``.
    Return at most ``limit`` records.
   * @param field 
   * @param limit 
   * @returns 
   */
  _inCacheWithout(field: Field, limit?: number): any;

  /**
   * Read from the database in order to fetch ``field`` (class `Field`
    instance) for ``this`` in cache.
   * @param field 
   */
  _fetchField(field): Promise<void>;

  /**
   * Returns rooturl for a specific given record.

      By default, it return the ir.config.parameter of base_url
      but it can be overridden by model.

      @returns the base url for this record
   */
  getBaseUrl(): Promise<string>;

  /**
   * Check the companies of the values of the given field names.

      @param fnames names of relational fields to check
      @throw UserError if the `companyId` of the value of any field is not in `[false, self.companyId]` (or `this` if
          class `~verp.addons.base.models.resCompany`).

      For class `~verp.addons.base.models.resUsers` relational fields, verifies record company is in `companyIds` fields.

      User with main company A, having access to company A and B, could be assigned or linked to records in company B.
   * @param fnames 
   */
  _checkCompany(fnames?: Dict<Field>): Promise<void>;

  _checkConcurrency(): Promise<void>

  _inheritsJoinCals(alias: string, fname: string, query: Query): Promise<string>;

  _loadRecordsWrite(values): Promise<void>;

  _loadRecordsCreate(values): Promise<any>;

  /**
   * Create or update records of this model, and assign XMLIDs.
    @param dataList: list of dicts with keys `xmlid` (XMLID to
        assign), `noupdate` (flag on XMLID), `values` (field values)
    @param update should be ``true`` when upgrading a module
    @returns the records corresponding to ``dataList``
   */
  _loadRecords(dataList: any[], update: boolean): Promise<any>;

  _addFakeFields(fields: Dict<any>): Dict<any>;

  /**
   * Generates record dicts from the data sequence.
    The result is a generator of dicts mapping field names to raw
    (unconverted, unvalidated) values.

    For relational fields, if sub-fields were provided the value will be
    a list of sub-records

    The following sub-fields may be set on the record (by key):
    * None is the nameGet for the record (to use with nameCreate/nameSearch)
    * "id" is the External ID for the record
    * ".id" is the Database ID for the record
   * @param fields 
   * @param data 
   * @param options 
   */
  _extractRecords(fields: any[], data: any[], log?: any, limit?: number);

  /**
   * Converts records from the source iterable (recursive dicts of
    strings) into forms which can be written to the database (via
    this.create or (ir.model.data)._update)

    @returns a list of triplets of [id, xid, record]: [number|null, string|null, dict]]
   * @param extracted 
   * @param options 
   */
  _convertRecords(records, log: Function);

  /**
   * Convert the ``values`` dictionary into the format of method `write`.
   * @param values 
   * @returns 
   */
  _convertToWrite(values: {}): Promise<{}>;

  load(fields: string[], data): Promise<{}>;

  _processEndUnlinkRecord(record: any): Promise<void>;

  invalidateCache(fnames?: string[], ids?: any): boolean;
  /**
   * Notify that fields will be or have been modified on ``this``. This
    invalidates the cache where necessary, and prepares the recomputation of
    dependent stored fields.

    @param fnames iterable of field names modified on records ``this``
    @param create whether called in the context of record creation
    @param before whether called before modifying records ``this``
   */
  modified(fnames?: any, create?: boolean, before?: boolean): Promise<void>;

  _modifiedTriggers(tree: Map<any, any>, create: boolean): Promise<IterableIterator<any>>;

  exists(): Promise<any>;

  /**
   * Verifies that there is no loop in a hierarchical structure of records,
    by following the parent relationship using the **parent** field until a
    loop is detected or until a top-level record is found.

    @param parent: optional parent field name (default: ``self._parentName``)
    @returns **true** if no loop was found, **false** otherwise.
   */
  _checkRecursion(parent?: any): Promise<boolean>;

  /**
   * Verifies that there is no loop in a directed graph of records, by
    following a many2many relationship with the given field name.

    @param fieldName: field to check
    @returns **true** if no loop was found, **false** otherwise.
   */
  _checkM2mRecursion(fieldName: string): Promise<boolean>;

  /**
   * Retrieve the External ID(s) of any database record.
    **Synopsis**: ``_getExternalIds() -> { 'id': ['module.externalId'] }``
    @returns map of ids to the list of their fully qualified External IDs
      in the form ``module.key``, or an empty list when there's no External
      ID for a record, e.g.::
          { 'id': ['module.extId', 'module.extIdBis'],
            'id2': [] }
   */
  _getExternalIds(): Promise<{}>;

  /**
   * Retrieve the External ID of any database record, if there
        is one. This method works as a possible implementation
        for a function field, to be able to add it to any
        model object easily, referencing it as ``Model.getExternalId``.

        When multiple External IDs exist for a record, only one
        of them is returned (randomly).

        @returns map of ids to their fully qualified XML ID,
                 defaulting to an empty string when there's none
                 (to be usable as a function field),
                 e.g.::

                     { 'id': 'module.extId',
                       'id2': '' }
   */
  getExternalId(): Promise<{}>;

  /**
   * Generates a default single-line form view using all fields
      of the current model.

      @returns a form view as an lxml document
   */
  _getDefaultFormView(): Element;

  /**
   * Generates a single-field search view, based on _recName.

    @returns a tree view as an lxml document
   */
  _getDefaultSearchView(): Element;

  /**
   * Generates a single-field tree view, based on _recName.

      @returns a tree view as an lxml document
   */
  _getDefaultTreeView(): Element;

  /**
   * Generates an empty pivot view.

      @returns a pivot view as an lxml document
   */
  _getDefaultPivotView(): Element;;

  /**
   * Generates a single-field kanban view, based on _recName.

    @returns a kanban view as an lxml document
   */
  _getDefaultKanbanView(): Element;

  /**
   * Generates a single-field graph view, based on _recName.

      @returns a graph view as an lxml document
   */
  _getDefaultGraphView(): Element;

  /**
   * Generates a default calendar view by trying to infer
      calendar fields from a number of pre-set attribute names

      @returns a calendar view
   */
  _getDefaultCalendarView(): Promise<Element>;

  loadViews(kw: { views?: any, options?: {} }): Promise<{}>;

  _fieldsViewGet(viewId?: number, viewType?: string, toolbar?: boolean, submenu?: boolean): Promise<{}>;

  /**
   * fieldsViewGet([viewId | viewType='form'])

    Get the detailed composition of the requested view like fields, model, view architecture

    @param viewId id of the view or None
    @param viewType type of the view to return if viewId is None ('form', 'tree', ...)
    @param toolbar true to include contextual actions
    @param submenu deprecated
    @returns composition of the requested view (including inherited views and extensions)
    @throw AttributeError
            * if the inherited view has unknown position to work with other than 'before', 'after', 'inside', 'replace'
            * if some tag other than 'position' is found in parent view
    @throw Invalid ArchitectureError: if there is view type other than form, tree, calendar, search etc defined on the structure
   */
  fieldsViewGet(viewId?: number, viewType?: string, toolbar?: boolean, submenu?: boolean): Promise<{}>;

  /**
   * Return an view id to open the document ``this`` with. This method is meant to be overridden in addons that want to give specific view ids for example.

    Optional access_uid holds the user that would access the form view id different from the current environment user.
   * @param accessUid 
   * @returns 
   */
  getFormviewId(accessUid?: number): Promise<any>;


  /**
   * Return an action to open the document ``this``. This method is meant to be overridden in addons that want to give specific view ids for example.

    An optional access_uid holds the user that will access the document that could be different from the current user. 
   * @param accessUid 
   * @returns 
   */
  getFormviewAction(accessUid?: number): Promise<{}>;

  /**
   * Return an action to open the document. This method is meant to be
    overridden in addons that want to give specific access to the document. By default it opens the formview of the document.

    An optional access_uid holds the user that will access the document that could be different from the current user.
   * @param accessUid 
   * @returns 
   */
  getAccessAction(accessUid?: number): Promise<{}>;

  recompute(fnames?: string[], records?: any): Promise<void>;

  /**
   * Return an iterator on the fields that depend on ``field``.
   * @param field 
   */
  _dependentFields(field: Field): IterableIterator<any>;

  _whereCalc(domain: any[], activeTest?: boolean): Promise<Query>;

  /**
   * Flush writing to the database
   * @param fnames 
   * @param records 
   * @returns 
   */
  flush(fnames?: string[], records?: any): Promise<void>;


  /**
   * Add possibly missing JOIN with translations table to ``query`` and
      generate the expression for the translated field.

      @returns the qualified field name (or expression) to use for ``field``
   * @param {*} tableAlias 
   * @param {*} field 
   * @param {*} query 
   * @returns 
   */
  _generateTranslatedField(tableAlias: string, field: string, query: Query): string;

  _generateOrderByInner(alias: string, orderSpec: string, query: Query, reverseDirection?: boolean, seen?: Set<any>): Promise<[]>;

  _checkQorder(word: string): Promise<boolean>;

  /**
   * Add missing table SELECT and JOIN clause to ``query`` for reaching the parent table (no duplicates)
    @param currentModel current model object
    @param parentModelName name of the parent model for which the clauses should be added
    @param query query object on which the JOIN should be added
   */
  _inheritsJoinAdd(currentModel, parentModelName, query: Query): string;

  /**
   *  Adds missing table select and join clause(s) to ``query`` for reaching
      the field coming from an '_inherits' parent table (no duplicates).
      @param alias name of the initial SQL alias
      @param fname name of inherited field to reach
      @param query query object on which the JOIN should be added
      @returns qualified name of field, to be used in SELECT clause
   */
  _inheritsJoinCalc(alias: string, fname: string, query: Query): Promise<string>;

  /**
   *     Add possibly missing JOIN to ``query`` and generate the ORDER BY clause for m2o fields,
    either native m2o fields or function/related fields that are stored, including
    intermediate JOINs for inheritance if required.
   * @param alias 
   * @param orderField 
   * @param query 
   * @param doReverse 
   * @param seen 
   * @returns the qualified field name to use in an ORDER BY clause to sort by ``orderField``
   */
  _generateM2oOrderBy(alias: string, orderField: string, query: Query, reverseDirection: boolean, seen: Set<any>): Promise<any[]>;

  /**
   *  Attempt to construct an appropriate ORDER BY clause based on orderSpec, which must be
      a comma-separated list of valid field names, optionally followed by an ASC or DESC direction.
      @throw ValueError in case orderSpec is malformed
   */
  _generateOrderBy(orderSpec: string, query: Query): Promise<string>;

  /**
   * Generic method giving the help message displayed when having
    no result to display in a list or kanban view. By default it returns
    the help given in parameter that is generally the help message
    defined in the action.
   * @param help 
   * @returns 
   */
  getEmptyListHelp(help: string): Promise<string>;

  _applyIrRules(query: Query, mode?: string): Promise<void>;

  /**
   * defaultGet(fieldsList) -> defaultValues

    Return default values for the fields in ``fieldsList``. Default
    values are determined by the context, user defaults, and the model
    itself.

    @param fieldsList names of field whose default is requested
    @returns a dictionary mapping field names to their corresponding default values,
        if they have a default value.

        Unrequested defaults won't be considered, there is no need to return a
        value for fields whose names are not in `fields_list`.
   * @param fieldsList 
   */
  defaultGet(fieldsList: any[]): Promise<Dict<any>>;

  fieldsGet(allfields?: any, attributes?: any): Promise<{}>;

  fieldsGetKeys(): string[];

  _recNameFallback(): string;

  /**
   * Flush all the fields appearing in `domain`, `fields` and `order`.
   * @param domain 
   * @param options 
   */
  _flushSearch(domain: any[], options?: { fields?: any, order?: string, seen?: Set<string> }): Promise<void>;

  /**
   * Return the list of actual record ids corresponding to ``this``. 
   */
  get ids(): any[];

  get id(): any;

  get cls(): any;

  get _cr(): Cursor;

  get _uid(): number;

  get _context(): {};

  get _fields(): Dict<Field>;

  /**
   * Return the actual records corresponding to ``this``.
   */
  get _origin(): any;

  /**
   * Return the cache of ``this``, mapping field names to values.
   */
  private __cache__: RecordCache;

  get _cache(): RecordCache;

  get _length(): number;

  /**
   * Test whether ``this`` is nonempty.
   */
  get ok(): boolean;

  get nok(): boolean;

  _bool(): boolean;

  _hash(): string;

  _int(): number;

  toString(): string;

  repr(): string;

  valueOf(): string;

  has(id: number): boolean;

  includes(item: any): boolean;

  contains(item: any): boolean;

  [Symbol.iterator](): IterableIterator<any>;

  forEach(func: Function): void;

  add(others: any): any;

  concat(others: any): any;

  union(others): any;

  slice(start: number, end: number): any;

  sub(other: any): any

  and(other: any): any;

  or(other: any): any;

  eq(other: any): boolean;

  ne(other: any): boolean;

  lt(other: any): boolean;

  le(other: any): boolean;

  gt(other: any): boolean;

  ge(other: any): boolean;

  _t(source: string, ...args: any[]): Promise<string>;

  /**
   * Verify that the current recorset holds a single record.
    @throw core.exceptions.ValueError: ``len(this) != 1``
   * @returns 
   */
  ensureOne(): any;

  /**
   * Update the records in 'this' with 'values'.
   * @param {*} values 
   */
  update(values): Promise<void>;

  /**
   * Assign the field 'fieldName' to 'value' in record 'this'.
   * @param fieldName 
   * @param value 
   */
  set(fieldName: string, value: any): Promise<void>;

  /**
   * a = _getValue('a')              => args = ['a']
   * [a] = _getValue(['a'])          => args = [['a']]
   * [a, b] = _getValue('a', 'b')    => args = ['a', 'b']
   * [a, b] = _getValue(['a', 'b'])  => args = [['a', 'b']]
   * @param fieldNames 
   * @returns 
   */
  _getValue(...fieldNames: any[]): Promise<any>;

  getDict(...fieldNames: any[]): Promise<Dict<any>>;

  sudo(flag?: boolean): Promise<any>;

  withEnv(env: Environment): any;

  withUser(user?: any): Promise<any>;

  /**
   * with_company(company)

    Return a new version of this recordset with a modified context, such that::

        result.env.company = company
        result.env.companies = self.env.companies | company

    @param company: main company of the new environment.

    .. warning::

        When using an unauthorized company for current user,
        accessing the company(ies) on the environment may trigger
        an AccessError if not done in a sudoed environment.
   * @param company 
   * @returns 
   */
  withCompany(company?: number | ModelRecords): Promise<any>;

  /**
   * with_context([context][, **overrides]) -> records

    Returns a new version of this recordset attached to an extended
    context.

    The extended context is either the provided ``context`` in which
    ``overrides`` are merged or the *current* context in which
    ``overrides`` are merged e.g.::

        // current context is {'key1': true}
        r2 = records.with_context({}, key2=true)
        // -> r2._context is {'key2': true}
        r2 = records.with_context(key2=true)
        // -> r2._context is {'key1': true, 'key2': true}

    .. note:

        The returned recordset has the same prefetch object as ``this``.
   * @param args 
   */
  withContext(args?: {}, kwargs?: {}): Promise<any>;

  withPrefetch(prefetchIds?: number[]): Promise<any>;

  _updateCache(values: {}, validate: boolean): Promise<void>;

  _checkRemovedColums(log: boolean): Promise<void>;

  /**
   * """ Initialize the value of the given column for existing rows. """
    // get the default value; ideally, we should use defaultGet(), but it
    // fails due to ir.default not being ready
   * @param columnName 
   */
  _initColumn(columnName: string): Promise<void>;

  /**
   *  Return whether the model's table has rows. This method should only
      be used when updating the database schema (method `~._autoInit`).
   * @returns 
   */
  _tableHasRows(): Promise<number>;

  /**
   * Initialize the database schema of ``this``:
    - create the corresponding table,
    - create/update the necessary columns/tables for fields,
    - initialize new columns on existing rows,
    - add the SQL constraints given on the model,
    - add the indexes on indexed fields,

    Also prepare post-init stuff to:
    - add foreign key constraints,
    - reflect models, fields, relations and constraints,
    - mark fields to recompute on existing records.

    Note: you should not override this method. Instead, you can modify
    the model's database schema by overriding method method `~.init`,
    which is called right after this one.
   */
  _autoInit(): Promise<void>;

  _createParentColumns(): Promise<void>;

  _addSqlConstraints(): Promise<void>;

  tableQuery(): Promise<string>;

  _executeSql(): Promise<void>;

  /**
   * Compute parent_path field from scratch.
   * @returns 
   */
  _parentStoreCompute(): Promise<boolean>;

  /**
   * This method is called after method `~._autoInit`, and may be
    overridden to create or modify a model's database schema.
   */
  init(force?: boolean): Promise<void>;

  /**
   * Override this method to do specific things when a form view is
    opened. This method is invoked by method `~defaultGet`.
   * @param fieldsList 
   * @returns 
   */
  viewInit(fieldsList: string[]): Promise<void>;

  _mappedFunc(func: Function): Promise<any>;

  /**
   * Apply ``func`` on all records in ``this``, and return the result as alist or a recordset (if ``func`` return recordsets). In the latter case, the order of the returned recordset is arbitrary.

    @param func a function or a dot-separated sequence of field names
    @returns self if func is falsy, result of func applied to all ``this`` records.

    returns a list of summing two fields for each record in the set
        records.mapped(async (r) => r.field1 + r.field2)

    The provided function can be a string to get field values:

        // returns a list of labels
        records.mapped('label')

        // returns a recordset of partners
        records.mapped('partnerId')

        // returns of the union of all partner banks, with duplicates removed
        records.mapped('partnerId.bankIds')
    * @param func 
    * @returns 
    */
  mapped(func: String | Function): Promise<any>;

  map(func: Function): Promise<any[]>;

  filter(func: Function): Promise<any[]>;

  some(func: Function): Promise<boolean>;

  sum(func: Function): Promise<number>;;

  all(func: Function): Promise<boolean>;

  every(func: Function): Promise<boolean>;

  /**
   * Return the records in ``this`` satisfying ``func``.
    @param func a function or a dot-separated sequence of field names
    @returns recordset of records satisfying func, may be empty.

    .. code-block:: python3

        // only keep records whose company is the current user's
        records.filtered((r => r.companyId == user.companyId)

        // only keep records whose partner is a company
        records.filtered("partnerId.isCompany")
    * @param func 
    * @returns 
    */
  filtered(func: any): Promise<any>;;

  filteredDomain(domain: any[]): Promise<any>;;

  /**
   * Return the recordset ``this`` ordered by ``key``.
    @param key either a function of one argument that returns a
        comparison key for each record, or a field name, or ``None``, in
        which case records are ordered according the default model's order
    @param reverse if ``true``, return the result in reverse order

        // sort records by name
        records.sorted((r) => r.name)
   * @param self 
   * @param key 
   * @param reverse 
   */
  sorted(key?: any, reverse?: boolean): Promise<any>;

  reversed(key?: any): Promise<any>;

  /**
   * Return a dict mapping symbolic sizes ('small', 'medium', 'large') to integers,
          giving the minimal number of records that method `_populate` should create.
  
          The default population sizes are:
  
          * 'small' : 10
          * 'medium' : 100
          * 'large' : 1000
   * @returns 
   */
  _populateSizes: {};

  /**
   * Return the list of models which have to be populated before the current one.
   */
  _populateDependencies: [];

  /**
   * Create records to populate this model.
 
      @param size: symbolic size for the number of records: 'small', 'medium' or 'large'
   */
  _populate(size: number): Promise<any>;

  /**
   * Returns the filename of the placeholder to use,
      set on web/static/img by default, or the
      complete path to access it (eg: module/path/to/image.png).

      If a falsy value is returned, "ir.http"._placeholder() will use
      the default placeholder 'web/static/img/placeholder.png'.
   * @param field 
   * @returns 
   */
  _getPlaceholderFilename(field: Field): Promise<any>;

  /**
   * Return whether ``field`` should trigger an onchange event in the
        presence of ``otherFields``.
   * @param field 
   * @param otherFields 
   * @returns 
   */
  _hasOnChange(field: Field, otherFields: string[]): Promise<boolean>;

  _onchangeSpec(viewInfo?: any);

  /**
   * Apply onchange method(s) for field ``fieldName`` with spec ``onchange``
        on record ``this``. Value assignments are applied on ``this``, while
        domain and warning messages are put in dictionary ``result``.
   * @param fieldName 
   * @param onchange 
   * @param result 
   * @returns 
   */
  _onchangeEval(fieldName: string, onchange: string, result: any): Promise<void>;

  /**
   * Perform an onchange on the given field.
    @param values dictionary mapping field names to values, giving the
        current state of modification
    @param fieldName name of the modified field, or list of field
        names (in view order), or false
    @param fieldOnchange dictionary mapping field names to their
        onchange attribute

    When ``fieldName`` is falsy, the method first adds default values
    to ``values``, computes the remaining fields, applies onchange
    methods to them, and return all the fields in ``fieldOnchange``.
   */
  onchange(values: {}, fieldName: string | string[], fieldOnchange: {}): Promise<any>;

  // MailThread
  messagePost(options: string | any | {
    body?: string, subject?: string, messageType?: string,
    emailFrom?: string, authorId?: number, parentId?: number,
    subtypeXmlid?: number, subtypeId?: number, partnerIds?: number[],
    attachments?: any[], attachmentIds?: number[],
    addSign?: boolean, recordName?: any
  }): Promise<any>;

  // User
  hasGroup(group): Promise<boolean>;
}

/**
 * Mostly like BaseModel
   static _auto = false;               // not created database backend
   static _register = false;           // registry visibility
   static _abstract = true;            // abstract
   static _transient = false;          // not transient
 */
declare class AbstractModel extends BaseModel { }

declare class Model extends BaseModel { }

declare class TransientModel extends Model { }

/**
 * Check whether the given name is a valid PostgreSQL identifier name
 * @param name 
 */
declare function checkTableName(name: string): void;

declare function triggerTreeMerge(node1: Map<any, any>, node2: Map<any, any>): void;

declare function getmembers(cls: any, type: string, predicate: (func: any) => boolean): [string, Function, Function][];

/**
 * 
 * @param category 
 * @returns 
 */
declare function categoryXmlid(category: string[]): string;

/**
 * 
 * @param module 
 * @returns 
 */
declare function moduleXmlid(module: string): string;

/**
 * Return the XML id of the given model.
 * @param module 
 * @param modelName 
 * @returns 
 */
declare function modelXmlid(module: string, modelName: string): string;

/**
 * Return the XML id of the given field.
 * @param module 
 * @param modelName 
 * @param fieldName 
 * @returns 
 */
declare function fieldXmlid(module: string, modelName: string, fieldName: string): string;

/**
 * Return the XML id of the given selection.
 * @param module 
 * @param modelName 
 * @param fieldName 
 * @param value 
 * @returns 
 */
declare function selectionXmlid(module: string, modelName: string, fieldName: string, value: any): string;