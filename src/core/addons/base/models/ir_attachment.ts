import * as fs from 'fs';
import _ from 'lodash';
import * as mimetypes from 'mime-types';
import * as path from 'path';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { api, tools } from "../../..";
import { Fields } from "../../../fields";
import { DefaultDict, Dict } from "../../../helper/collections";
import { AccessError, UserError, ValidationError } from "../../../helper/errors";
import { MetaModel, Model, _super } from "../../../models";
import { ImageProcess, b64decode, b64encode, bool, config, fileClose, fileWrite, humanSize, isDir, isFile, sameContent, setOptions, sha1, str2bool } from '../../../tools';
import { isInstance } from "../../../tools/func";
import { extend, len } from "../../../tools/iterable";
import { guessMimetype } from '../../../tools/mimetypes';

/**
 * Attachments are used to link binary files or url to any verp document.

    External attachment storage
    ---------------------------

    The computed field ``datas`` is implemented using ``_file_read``,
    ``_file_write`` and ``_file_delete``, which can be overridden to implement
    other storage engines. Such methods should check for other location pseudo
    uri (example: hdfs://hadoopserver).

    The default implementation is the file:dirname location that stores files
    on the local filesystem using name based on their sha1 hash
 */
@MetaModel.define()
class IrAttachment extends Model {
  static _module = module;
  static _name = 'ir.attachment';
  static _description = 'Attachment';
  static _order = 'id desc';

  static label = Fields.Char('Label', { required: true });
  static description = Fields.Text('Description');
  static resName = Fields.Char('Resource Name', { compute: '_computeResName' });
  static resModel = Fields.Char('Resource Model', { readonly: true, help: "The database object this attachment will be attached to." });
  static resField = Fields.Char('Resource Field', { readonly: true });
  static resId = Fields.Many2oneReference('Resource ID', { modelField: 'resModel', readonly: true, help: "The record id this is attached to." });
  static companyId = Fields.Many2one('res.company', { string: 'Company', changeDefault: true, default: async (self) => await self.env.company() });
  static type = Fields.Selection([['url', 'URL'], ['binary', 'File']], { string: 'Type', required: true, default: 'binary', changeDefault: true, help: "You can either upload a file from your computer or copy/paste an internet link to your file." });
  static url = Fields.Char('Url', { index: true, size: 1024 });
  static isPublic = Fields.Boolean('Is public document');

  // for external access
  static accessToken = Fields.Char('Access Token', { groups: "base.groupUser" });

  // the field 'datas' is computed and may use the other fields below
  static raw = Fields.Binary({ string: "File Content (raw)", compute: '_computeRaw', inverse: '_inverseRaw' });
  static datas = Fields.Binary({ string: 'File Content (base64)', compute: '_computeDatas', inverse: '_inverseDatas' });
  static dbDatas = Fields.Binary('Database Data', { attachment: false });
  static storefname = Fields.Char('Stored Filename');
  static filesize = Fields.Integer('File Size', { readonly: true });
  static checksum = Fields.Char("Checksum/SHA1", { size: 40, index: true, readonly: true });
  static mimetype = Fields.Char('Mime Type', { readonly: true });
  static indexContent = Fields.Text('Indexed Content', { readonly: true, prefetch: false });

  async _computeResName() {
    for (const attachment of this) {
      const resModel = await attachment.resModel;
      const resId = await attachment.resId;
      if (resModel && resId) {
        const record = this.env.items(resModel).browse(resId);
        await attachment.set('resName', await record.displayName);
      }
      else {
        await attachment.set('resName', false);
      }
    }
  }

  async _autoInit() {
    await _super(IrAttachment, this)._autoInit();
    await tools.createIndex(this._cr, 'irAttachment_resId_index', this.cls._table, ['"resModel"', '"resId"']);
  }

  @api.constrains('type', 'url')
  async _checkServingAttachments() {
    if (await this.env.isAdmin()) {
      return;
    }
    for (const attachment of this) {
      // restrict writing on attachments that could be served by the
      // ir.http's dispatch exception handling
      // XDO note: this should be done in check(write), constraints for access rights?
      // XDO note: if read on sudo, read twice, one for constraints, one for _inverse_datas as user
      if (await attachment.type === 'binary' && await attachment.url) {
        if (! await (await attachment.getServingGroups()).some(async (g) => await (await this.env.user()).hasGroup(g))) {
          throw new ValidationError("Sorry, you are not allowed to write on this document");
        }
      }
    }
  }

  /**
   * Restricts the access to an ir.attachment, according to referred mode
   * @param mode 
   * @param values 
   * @returns 
   */
  @api.model()
  async check(mode, values?: Dict<any>) {
    if (this.env.isSuperuser()) {
      return true;
    }
    // Always require an internal user (aka, employee) to access to a attachment
    if (!(await this.env.isAdmin() || await (await this.env.user()).hasGroup('base.groupUser'))) {
      throw new AccessError(await this._t("Sorry, you are not allowed to access this document."));
    }
    // collect the records to check (by model)
    const modelIds = new DefaultDict();            // {modelName: set(ids)}
    if (this.ok) {
      await this.env.items('ir.attachment').flush(['resModel', 'resId', 'createdUid', 'isPublic', 'resField']);
      const res = await this._cr.execute(`SELECT "resModel", "resId", "createdUid", "isPublic", "resField" FROM "irAttachment" WHERE id IN (${String(this.ids) || 'NULL'})`);
      for (const { resModel, resId, createdUid, isPublic, resField } of res) {
        if (isPublic && mode === 'read') {
          continue;
        }
        if (! await this.env.isSystem() && (resField || (!resId && createdUid !== this.env.uid))) {
          throw new AccessError(await this._t("Sorry, you are not allowed to access this document."));
        }
        if (!(resModel && resId)) {
          continue
        }
        modelIds[resModel] = modelIds[resModel] ?? new Set<number>();
        modelIds[resModel].add(resId);
      }
    }
    if (values && values['resModel'] && values['resId']) {
      const _resModel = values['resModel'];
      modelIds[_resModel] = modelIds[_resModel] ?? new Set<number>();
      modelIds[_resModel].add(values['resId']);
    }

    // check access rights on the records
    for (const [resModel, resIds] of Object.entries(modelIds)) {
      // ignore attachments that are not attached to a resource anymore
      // when checking access rights (resource was deleted but attachment
      // was not)
      if (!(resModel in this.env.models)) {
        continue;
      }
      if (resModel === 'res.users' && len(resIds) === 1 && this.env.uid === [...resIds][0]) {
        // by default a user cannot write on itself, despite the list of writeable fields
        // e.g. in the case of a user inserting an image into his image signature we need to bypass this check which would needlessly throw us away
        continue;
      }
      const records = await this.env.items(resModel).browse(resIds).exists();
      // For related models, check if we can write to the model, as unlinking
      // and creating attachments can be seen as an update to the model
      const accessMode = ['create', 'unlink'].includes(mode) ? 'write' : mode;
      await records.checkAccessRights(accessMode);
      await records.checkAccessRule(accessMode);
    }
  }

  _readGroupAllowedFields() {
    return ['type', 'companyId', 'resId', 'createdAt', 'createdUid', 'label', 'mimetype', 'id', 'url', 'resField', 'resModel'];
  }

  /**
   * Override readGroup to add res_field=false in domain if not present.
   * @param domain 
   * @param fields 
   * @param groupby 
   * @param options 
   * @returns 
   */
  @api.model()
  async readGroup(domain: any[], fields: string[], groupby: any, options: { offset?: number, limit?: number, orderby?: any, lazy?: boolean } = {}) {
    setOptions(options, { offset: 0, limit: null, orderby: false, lazy: true });
    if (!bool(fields)) {
      throw new AccessError(await this._t("Sorry, you must provide fields to read on attachments"));
    }
    groupby = typeof (groupby) === 'string' ? [groupby] : groupby;
    if (fields.concat(groupby).some((field) => field.includes('('))) {
      throw new AccessError(await this._t("Sorry, the syntax 'name:agg(field)' is not available for attachments"));
    }
    if (!domain.some((item) => ['id', 'resField'].includes(item[0]))) {
      domain.unshift(['resField', '=', false]);
    }
    const allowedFields = this._readGroupAllowedFields();
    const fieldsSet = new Set(fields.concat(groupby).map(field => field.split(':')[0]));
    if (! await this.env.isSystem() && (!bool(fields) || _.difference([...fieldsSet], allowedFields).length)) {
      throw new AccessError(await this._t("Sorry, you are not allowed to access these fields on attachments."));
    }
    return _super(IrAttachment, this).readGroup(domain, fields, groupby, options);
  }

  @api.model()
  async _search(args: any, options: { offset?: number, limit?: number, order?: string, count?: boolean, accessRightsUid?: boolean } = {}) {
    setOptions(options, { offset: 0, limit: null, order: null, count: false, accessRightsUid: null });
    // add resField=false in domain if not present; the arg[0] trick below
    // works for domain items and '&'/'|'/'!' operators too
    let discardBinaryFieldsAttachments = false;
    if (!args.some(arg => ['id', 'resField'].includes(arg[0]))) {
      discardBinaryFieldsAttachments = true;
      args.unshift(['resField', '=', false]);
    }

    let ids = await _super(IrAttachment, this)._search(args, { offset: options.offset, limit: options.limit, order: options.order, count: false, accessRightsUid: options.accessRightsUid });

    if (this.env.isSuperuser()) {
      // rules do not apply for the superuser
      return options.count ? len(ids) : ids;
    }

    if (!bool(ids)) {
      return options.count ? 0 : [];
    }

    // Work with a set, as list.remove() is prohibitive for large lists of documents
    // (takes 20+ seconds on a db with 100k docs during searchCount()!)
    const origIds = ids;
    ids = new Set(ids);

    // For attachments, the permissions of the document they are attached to
    // apply, so we must remove attachments for which the user cannot access
    // the linked document.
    // Use pure SQL rather than read() as it is about 50% faster for large dbs (100k+ docs),
    // and the permissions are checked in super() and below anyway.
    const modelAttachments = new Dict<any>();
    const binaryFieldsAttachments = new Set();
    const res = await this._cr.execute(`SELECT id, "resModel", "resId", "isPublic", "resField" FROM "irAttachment" WHERE id IN (${String([...ids]) || 'NULL'})`);
    for (const row of res) {
      if (!row['resModel'] || row['isPublic']) {
        continue;
      }
      // modelAttachments = {resModel: {resId: set(ids)}}
      modelAttachments[row['resModel']] = modelAttachments[row['resModel']] ?? new Dict<any>();
      modelAttachments[row['resModel']][row['resId']] = modelAttachments[row['resModel']][row['resId']] ?? new Set();
      modelAttachments[row['resModel']][row['resId']].add(row['id']);
      // Should not retrieve binary fields attachments if not explicitly required
      if (discardBinaryFieldsAttachments && row['resField']) {
        binaryFieldsAttachments.add(row['id']);
      }
    }

    if (binaryFieldsAttachments.size) {
      binaryFieldsAttachments.forEach(e => ids.add(e));
    }

    // To avoid multiple queries for each attachment found, checks are
    // performed in batch as much as possible.
    for (const [resModel, targets] of modelAttachments.items()) {
      if (!(resModel in this.env.models)) {
        continue;
      }
      if (! await this.env.items(resModel).checkAccessRights('read', false)) {
        // remove all corresponding attachment ids
        targets.values().forEach(e => ids.add(e));
        continue;
      }
      // filter ids according to what access rules permit
      const targetIds = Array.from(targets.keys());
      const allowed = await (await this.env.items(resModel).withContext({ activeTest: false })).search([['id', 'in', targetIds]]);
      for (const resId of new Set<any>(_.difference(targetIds, allowed.ids))) {
        targets[resId].forEach(e => ids.add(e));
      }
    }

    // sort result according to the original sort ordering
    const result = origIds.filter(id => ids.has(id));

    // If the original search reached the limit, it is important the
    // filtered record set does so too. When a JS view receive a
    // record set whose length is below the limit, it thinks it
    // reached the last page. To avoid an infinite recursion due to the
    // permission checks the sub-call need to be aware of the number of
    // expected records to retrieve
    if (len(origIds) == options.limit && len(result) < (this._context['need'] ?? options.limit)) {
      const need = (this._context['need'] ?? options.limit) - len(result);
      extend(result, (await (await this.withContext({ need: need }))._search(args, {
        offset: options.offset + len(origIds),
        limit: options.limit, order: options.order, count: options.count,
        accessRightsUid: options.accessRightsUid
      })).split(0, options.limit - len(result)));
    }
    return options.count ? len(result) : Array.from(result);
  }

  async _read(fields: string[] = []) {
    await this.check('read');
    return _super(IrAttachment, this)._read(fields);
  }

  async write(vals) {
    await this.check('write', vals);
    // remove computed field depending of datas
    for (const field of ['filesize', 'checksum', 'storefname']) {
      delete vals[field];
    }
    if ('mimetype' in vals || 'datas' in vals || 'raw' in vals) {
      vals = await this._checkContents(vals);
    }
    return _super(IrAttachment, this).write(vals);
  }

  @api.modelCreateMulti()
  async create(valsList) {
    const recordSet = new Set<any>();

    // remove computed field depending of datas
    const list: Dict<any>[] = [];
    for (const vals of valsList) {
      const dict = new Dict<any>();
      for (const [key, value] of Object.entries<any>(vals)) {
        if (!['filesize', 'checksum', 'storefname'].includes(key)) {
          dict[key] = value;
        }
      }
      list.push(dict);
    }
    for (let values of list) {
      values = await this._checkContents(values);
      let [raw, datas] = [values.pop('raw', null), values.pop('datas', null)];
      if (raw || datas) {
        if (typeof raw === 'string') {
          // b64decode handles str input but raw needs explicit encoding
          raw = Buffer.from(raw);
        }
        values.updateFrom(await this._getDatasRelatedValues(
          raw || b64decode(datas || ''),
          values['mimetype']
        ));
      }

      // 'check()' only uses resModel and resId from values, and make an exists. We can group the values by model, resId to make only one query when creating multiple attachments on a single record.
      const _record = [values.get('resModel'), values.get('resId')];
      recordSet.add(_record);
    }

    // don't use possible contextual recordset for check, see commit for details
    const Attachments: any = this.browse();
    for (const [resModel, resId] of recordSet) {
      await Attachments.check('create', { 'resModel': resModel, 'resId': resId });
    }
    return _super(IrAttachment, this).create(list);
  }

  async unlink() {
    if (!this.ok)
      return true;
    await this.check('unlink');

    // First delete in the database, *then* in the filesystem if the
    // database allowed it. Helps avoid errors when concurrent transactions
    // are deleting the same file, and some of the transactions are
    // rolled back by PostgreSQL (due to concurrent updates detection).
    const toDelete = new Set<string>();
    for (const attach of this) {
      const storefname = await (attach as any).storefname;
      if (storefname) {
        toDelete.add(storefname);
      }
    }

    const res = await _super(IrAttachment, this).unlink();
    for (const filePath of toDelete) {
      this._fileDelete(filePath)
    }

    return res;
  }

  @api.model()
  async _storage() {
    return (await this.env.items('ir.config.parameter').sudo()).getParam('irAttachment.location', 'file');
  }

  @api.model()
  _filestore() {
    return config.filestore(this._cr.dbName);
  }

  @api.model()
  _fullPath(p: string) {
    // sanitize path
    p = p.replace(/[.]/, '');
    p = p.replace(/\\/, '');
    return path.join(this._filestore(), p);
  }

  @api.model()
  _getPath(binData, sha) {
    // retro compatibility
    let fname = sha.slice(0, 3) + '/' + sha;
    let fullPath = this._fullPath(fname);
    if (isFile(fullPath)) {
      return [fname, fullPath]        // keep existing path
    }

    // scatter files across 256 dirs
    // we use '/' in the db (even on windows)
    fname = sha.slice(0, 2) + '/' + sha;
    fullPath = this._fullPath(fname);
    const dirname = path.dirname(fullPath);
    if (!isDir(dirname)) {
      fs.mkdirSync(dirname, { recursive: true });
    }
    // prevent sha-1 collision
    if (isFile(fullPath) && !sameContent(binData, fullPath)) {
      throw new UserError("The attachment is colliding with an existing file.");
    }
    return [fname, fullPath];
  }

  @api.model()
  _fileRead(fname) {
    const fullPath = this._fullPath(fname);
    try {
      const f = fs.openSync(fullPath, 'r');
      const data = fs.readFileSync(f);
      fs.closeSync(f);
      return data;
    } catch (e) {
      console.log("Error reading %s\n%s", fullPath, e);
    }
    return Buffer.from('', 'ascii');
  }

  @api.model()
  _fileWrite(binValue, checksum) {
    const [fname, fullPath] = this._getPath(binValue, checksum);
    if (!fs.existsSync(fullPath)) {
      try {
        fileWrite(fullPath, binValue);
        // add fname to checklist, in case the transaction aborts
        this._markForGc(fname);
      } catch (e) {
        console.log("_fileWrite error writing %s", fullPath);
      }
    }
    return fname;
  }

  @api.model()
  _fileDelete(fname) {
    // simply add fname to checklist, it will be garbage-collected later
    this._markForGc(fname);
  }

  /**
   * Add ``fname`` in a checklist for the filestore garbage collection.
   * @param fname 
   */
  _markForGc(fname: string) {
    fname = fname.replace(/[.]/, '');
    fname = fname.replace(/\\/, '');
    // we use a spooldir: add an empty file in the subdirectory 'checklist'
    const fullPath = path.join(this._fullPath('checklist'), fname);
    if (!fs.existsSync(fullPath)) {
      const dirname = path.dirname(fullPath);
      if (!isDir(dirname)) {
        try {
          fs.mkdirSync(dirname, { recursive: true });
        } catch (e) { }
      }
      fileClose(fs.openSync(fullPath, 'a'));
    }
  }

  @api.depends('storefname', 'dbDatas', 'filesize')
  @api.dependsContext('binSize')
  async _computeDatas() {
    if (this._context['binSize']) {
      for (const attach of this) {
        await attach.set('datas', humanSize(await attach.filesize));
      }
      return;
    }
    for (const attach of this) {
      let data = await attach.raw;
      data = b64encode(data || '');
      await attach.set('datas', data);
    }
  }

  @api.depends('storefname', 'dbDatas')
  async _computeRaw() {
    for (const attach of this) {
      const storefname = await attach.storefname;
      if (storefname) {
        const data = await attach._fileRead(storefname);
        await attach.set('raw', data);
      }
      else {
        const datas = await attach.dbDatas;
        await attach.set('raw', datas);
      }
    }
  }

  async _inverseRaw() {
    await this._setAttachmentData(async (attach) => await attach.raw || '');
  }

  async _inverseDatas() {
    await this._setAttachmentData(async (attach) => b64decode(await attach.datas || ''));
  }

  async _setAttachmentData(asbytes) {
    for (const attach of this) {
      // compute the fields that depend on datas
      const binData = await asbytes(attach);
      const vals = await this._getDatasRelatedValues(binData, await attach.mimetype);

      // take current location in filestore to possibly garbage-collect it
      const fname = await attach.storefname;
      // write as superuser, as user probably does not have write access
      await _super(IrAttachment, await attach.sudo()).write(vals);
      if (fname) {
        this._fileDelete(fname);
      }
    }
  }

  async _getDatasRelatedValues(data, mimetype: string) {
    const checksum = this._computeChecksum(data)
    let indexContent;
    try {
      indexContent = this._index(data, mimetype, checksum);
    } catch (e) {
      if (isInstance(e, TypeError)) {
        indexContent = this._index(data, mimetype);
      }
      else {
        throw e;
      }
    }
    const values = {
      'filesize': len(data),
      'checksum': checksum,
      'indexContent': indexContent,
      'storefname': false as any,
      'dbDatas': data,
    }
    if (data.length && await this._storage() !== 'db') {
      values['storefname'] = this._fileWrite(data, values['checksum']);
      values['dbDatas'] = false;
    }
    return values
  }

  /**
   * compute the checksum for the given datas

   * @param binData datas in its binary form
   * @returns 
   */
  _computeChecksum(binData: any, algorithm?: string, encoding?: any) {
    return sha1(binData || '');
  }

  @api.model()
  _sameContent_All(binData: Buffer, filepath: string) {
    const temp = fs.readFileSync(filepath);
    if (temp.compare(binData) !== 0) {
      return false;
    }
    return true
  }

  async _checkContents(values) {
    const mimetype = values['mimetype'] = await this._computeMimetype(values);
    const xmlLike = mimetype.includes('ht') || (  // hta, html, xhtml, etc.
      mimetype.includes('xml') &&                 // other xml (svg, text/xml, etc)
      !(mimetype.includes('openxmlformats')))     // exception for Office formats
    const user = this.env.context['binaryFieldRealUser'] ?? await this.env.user();
    if (user.cls._name !== this.pool.models['res.users']._name) {
      throw new UserError(await this._t("binaryFieldRealUser should be a res.users record."));
    }
    const forceText = xmlLike && (
      this.env.context['attachmentsMimePlainxml'] ||
      !(await (await this.env.items('ir.ui.view').withUser(user))).checkAccessRights('write', false)
    );
    if (forceText) {
      values['mimetype'] = 'text/plain';
    }
    if (!this.env.context['imageNoPostprocess']) {
      values = await this._postprocessContents(values);
    }
    return values;
  }

  /**
   * compute the index content of the given binary data.
        This is a javascript implementation of the unix command 'strings'.

   * @param binData datas in binary form
   * @param fileType 
   * @param checksum 
   * @returns string containing all the printable character of the binary data
   */
  @api.model()
  _index(binData, fileType, checksum?: any) {
    let indexContent;
    if (fileType) {
      indexContent = fileType.split('/')[0];
      if (indexContent === 'text') { // compute indexContent only for text type
        const matches = binData.toString('ascii').matchAll(/[\x20-\x7E]{4,}/g);
        const words = [];
        for (const m of matches) {
          const found = m[1];
          words.push(m[0]);
        }
        indexContent = words.join('\n');
      }
    }
    return indexContent;
  }

  /**
   * compute the mimetype of the given values

   * @param values dict of values to create or write an irAttachment
   * @returns string indicating the mimetype, or application/octet-stream by default
   */
  async _computeMimetype(values: any): Promise<any> {
    let mimetype = null;
    if (values['mimetype']) {
      mimetype = values['mimetype'];
    }
    if (!mimetype && values['label']) {
      mimetype = mimetypes.lookup(values['label']);
    }
    if (!mimetype && values['url']) {
      mimetype = mimetypes.lookup(values['url'].split('?')[0]);
    }
    if (!mimetype || mimetype === 'application/octet-stream') {
      let raw = null;
      if (values['raw']) {
        raw = values['raw'];
      }
      else if (values['datas']) {
        raw = b64decode(values['datas']);
      }
      if (bool(raw)) {
        mimetype = guessMimetype(raw);
      }
    }
    return mimetype ?? 'application/octet-stream';
  }

  async _postprocessContents(values: any): Promise<any> {
    const sudo = await this.env.items('ir.config.parameter').sudo();
    const ICP = sudo.getParam.bind(sudo);
    const supportedSubtype = (await ICP('base.imageAutoresizeExtensions', 'png,jpeg,bmp,tiff')).split(',')

    const mimetype = values['mimetype'] = await this._computeMimetype(values);
    const [_type, _subtype] = mimetype.split('/');
    const isImageResizable = _type === 'image' && supportedSubtype.includes(_subtype);
    if (isImageResizable && (values['datas'] ?? values['raw'])) {
      const isRaw = values['raw'];

      // Can be set to 0 to skip the resize
      const maxResolution = await ICP('base.imageAutoresizeMaxPx', '1920x1920');
      if (str2bool(maxResolution, true)) {
        try {
          let img: ImageProcess;
          let fnQuality: Function;
          let meta: sharp.Metadata;
          if (isRaw) {
            img = await ImageProcess.new(false, false);
            img.image = sharp(Buffer.from(values['raw']));
            meta = await img.image.metadata();
            img.originalFormat = (meta.format || '').toUpperCase();
          }
          else {  // datas
            img = await ImageProcess.new(values['datas'], false);
            meta = await img.image.metadata();
          }
          const [w, h] = [meta.width, meta.height];
          const [nw, nh] = maxResolution.split('x').map(x => parseInt(x));
          if (w > nw || h > nh) {
            img = await img.resize(nw, nh);
            const quality = parseInt(ICP('base.imageAutoresizeQuality', 80));
            fnQuality = isRaw ? img.imageQuality : img.imageBase64
            values[(isRaw && 'raw') ?? 'datas'] = await fnQuality(quality);
          }
        } catch (e) {
          if (isInstance(e, UserError)) {
            console.info('Post processing ignored : %s', e);
          } else {
            // Catch error during test where we provide fake image
            throw new UserError(await this._t("This file could not be decoded as an image file. Please try with a different file."), e);
          }
        }
      }
    }
    return values;
  }

  async generateAccessToken() {
    const tokens = [];
    for (const attachment of this) {
      if (await attachment.accessToken) {
        tokens.push(await attachment.accessToken);
        continue;
      }
      const accessToken = this._generateAccessToken();
      await attachment.write({ 'accessToken': accessToken });
      tokens.push(accessToken);
    }
    return tokens;
  }

  _generateAccessToken() {
    return uuidv4();
  }

  @api.model()
  async actionGet() {
    return this.env.items("ir.actions.actions")._forXmlid('base.actionAttachment')
  }

  @api.model()
  async getServeAttachment(url, extraDomain?: any, extraFields?: any, order?: any) {
    const domain = [['type', '=', 'binary'], ['url', '=', url]].concat(extraDomain ?? []);
    const fieldNames = ['__lastUpdate', 'datas', 'mimetype'].concat(extraFields ?? []);
    return this.searchRead(domain, fieldNames, { order, limit: 1 });
  }
}