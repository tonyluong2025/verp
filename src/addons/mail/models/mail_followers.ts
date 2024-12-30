import _ from "lodash";
import { api } from "../../../core";
import { Command, Fields } from "../../../core/fields";
import { DefaultDict } from "../../../core/helper/collections";
import { MetaModel, Model, _super } from "../../../core/models"
import { bool, chain, iter, len, next, setOptions } from "../../../core/tools";
import { f } from "../../../core/tools/utils";
import { setdefault } from "../../../core/api/func";

/**
 * mail_followers holds the data related to the follow mechanism inside
    Verp. Partners can choose to follow documents (records) of any kind
    that inherits from mail.thread. Following documents allow to receive
    notifications for new messages. A subscription is characterized by:

    :param: resModel: model of the followed objects
    :param: resId: ID of resource (may be 0 for every objects)
 */
@MetaModel.define()
class Followers extends Model {
  static _module = module;
  static _name = 'mail.followers';
  static _recName = 'partnerId';
  static _logAccess = false;
  static _description = 'Document Followers';

  // Note. There is no integrity check on model names for performance reasons.
  // However, followers of unlinked models are deleted by models themselves
  // (see 'ir.model' inheritance).
  static resModel = Fields.Char(
    'Related Document Model Name', {required: true, index: true});
  static resId = Fields.Many2oneReference(
      'Related Document ID', {index: true, help: 'Id of the followed resource', modelField: 'resModel'})
  static partnerId = Fields.Many2one(
      'res.partner', {string: 'Related Partner', index: true, ondelete: 'CASCADE', required: true, domain: [['type', '!=', 'private']]})
  static subtypeIds = Fields.Many2many(
      'mail.message.subtype', {string: 'Subtype',
      help: "Message subtypes followed, meaning subtypes that will be pushed onto the user's Wall."})
  static label = Fields.Char('Name', {related: 'partnerId.label'})
  static email = Fields.Char('Email', {related: 'partnerId.email'})
  static isActive = Fields.Boolean('Is Active', {related: 'partnerId.active'});

  static _sql_constraints = [
    ['mail_followers_res_partner_res_model_id_uniq', 'unique("resModel","resId","partnerId")', 'Error, a partner cannot follow twice the same object.'],
  ]

  /**
   * Invalidate the cache of the documents followed by ``self``.

    Modifying followers change access rights to individual documents. As the
    cache may contain accessible/inaccessible data, one has to refresh it.
   * @param self 
   * @param vals_list 
   */
  async _invalidateDocuments(valsList?: any) {
    const toInvalidate = new DefaultDict()//list)
    if (!valsList) {
      valsList = [];
      for (const rec of this) {
        valsList.push({'resModel': await rec.resModel, 'resId': await rec.resId});
      }
    }
    for (const record of valsList) {
      if (record['resId']) {
        const key = record['resModel'];
        toInvalidate[key] = toInvalidate[key] ?? [];
        toInvalidate[key].push(record['resId']);
      }
    }
  }

  @api.modelCreateMulti()
  async create(valsList) {
    const res = await _super(Followers, this).create(valsList);
    await res._invalidateDocuments(valsList);
    return res;
  }

  async write(vals) {
    if ('resModel' in vals || 'resId' in vals) {
      await this._invalidateDocuments();
    }
    const res = await _super(Followers, this).write(vals);
    if (['resModel', 'resId', 'partnerId'].some(x => x in vals)) {
      await this._invalidateDocuments();
    }
    return res;
  }

  async unlink() {
    await this._invalidateDocuments();
    return _super(Followers, this).unlink();
  }

  // --------------------------------------------------
  // Private tools methods to fetch followers data
  // --------------------------------------------------

  /**
   * Private method allowing to fetch recipients data based on a subtype.
    Purpose of this method is to fetch all data necessary to notify recipients
    in a single query. It fetches data from

      * followers (partners and channels) of records that follow the given
        subtype if records and subtype are set;
      * partners if pids is given;

    :param records: fetch data from followers of records that follow subtypeId;
    :param messageType: mail.message.messageType in order to allow custom behavior depending on it (SMS for example);
    :param subtypeId: mail.message.subtype to check against followers;
    :param pids: additional set of partner IDs from which to fetch recipient data;

    :return: list of recipient data which is a tuple containing
      partner ID ,
      active value (always true for channels),
      share status of partner,
      notification status of partner or channel (email or inbox),
      user groups of partner,
   * @param records 
   * @param messageType 
   * @param subtypeId 
   * @param pids 
   */
  async _getRecipientData(records, messageType, subtypeId, pids?: any) {
    // await  Promise.all([
      await this.env.items('mail.followers').flush(['partnerId', 'subtypeIds']),
      await this.env.items('mail.message.subtype').flush(['internal']),
      await this.env.items('res.users').flush(['notificationType', 'active', 'partnerId', 'groupsId']),
      await this.env.items('res.partner').flush(['active', 'partnerShare']),
      await this.env.items('res.groups').flush(['users'])
    // ]);
    let res;
    if (records && subtypeId) {
      const query = `
SELECT DISTINCT ON (pid) * FROM (
  WITH "subFollowers" AS (
      SELECT fol."partnerId",
            coalesce(subtype.internal, false) as internal
        FROM "mailFollowers" fol
        JOIN "mailFollowersMailMessageSubtypeRel" subrel ON subrel."mailFollowersId" = fol.id
        JOIN "mailMessageSubtype" subtype ON subtype.id = subrel."mailMessageSubtypeId"
        WHERE subrel."mailMessageSubtypeId" = %s
          AND fol."resModel" = '%s'
          AND fol."resId" IN (%s)

    UNION ALL

      SELECT id,
              FALSE
        FROM "resPartner"
        WHERE id IN (%s)
  )
  SELECT partner.id as pid,
          partner.active as active,
          partner."partnerShare" as pshare,
          users."notificationType" AS notif,
          array_agg("groupsRel".gid) AS groups
    FROM "resPartner" partner
LEFT JOIN "resUsers" users ON users."partnerId" = partner.id
                        AND users.active
LEFT JOIN "resGroupsUsersRel" "groupsRel" ON "groupsRel".uid = users.id
    JOIN "subFollowers" ON "subFollowers"."partnerId" = partner.id
                      AND NOT ("subFollowers".internal AND partner."partnerShare")
      GROUP BY partner.id,
                users."notificationType"
) AS x
ORDER BY pid, notif
`
      const params = [subtypeId, records._name, String(records.ids) || 'null', String(pids) || 'null'];
      res = await this.env.cr.execute(query, params);
    }
    else if (pids) {
      const queryPid = `
SELECT partner.id as pid,
  partner.active as active, partner."partnerShare" as pshare,
  users."notificationType" AS notif,
  array_agg("groupsRel".gid) FILTER (WHERE "groupsRel".gid IS NOT NULL) AS groups
FROM "resPartner" partner
  LEFT JOIN "resUsers" users ON users."partnerId" = partner.id AND users.active
  LEFT JOIN "resGroupsUsersRel" "groupsRel" ON "groupsRel".uid = users.id
WHERE partner.id IN (%s)
GROUP BY partner.id, users."notificationType"`;
      const params = [String(pids) || 'null'];
      const query = f('SELECT DISTINCT ON (pid) * FROM (%s) AS x ORDER BY pid, notif', queryPid);
      res = await this.env.cr.execute(query, params);
    }
    else {
      res = [];
    }
    return res;
  }

  /**
   * Private method allowing to fetch follower data from several documents of a given model.
    Followers can be filtered given partner IDs and channel IDs.

    :param doc_data: list of pair (resModel, resIds) that are the documents from which we
      want to have subscription data;
    :param pids: optional partner to filter; if None take all, otherwise limitate to pids
    :param include_pshare: optional join in partner to fetch their share status
    :param include_active: optional join in partner to fetch their active flag

    :return: list of followers data which is a list of tuples containing
      follower ID,
      document ID,
      partner ID,
      followed subtype IDs,
      share status of partner (returned only if include_pshare is true)
      active flag status of partner (returned only if include_active is true)
   * @param docData 
   * @param pids 
   * @param includePshare 
   * @param includeActive 
   * @returns 
   */
  async _getSubscriptionData(docData, pids, includePshare: boolean=false, includeActive: boolean=false) {
    // base query: fetch followers of given documents
    let whereClause = _.fill(Array(len(docData)), `fol."resModel" = '%s' AND fol."resId" IN (%s)`).join(' OR ');
    let whereParams = [];
    for (const [rm, rids] of docData) {
      whereParams = whereParams.concat([rm, String(rids) || 'NULL']);
    }
    // list(itertools.chain.from_iterable((rm, tuple(rids)) for rm, rids in doc_data))

    // additional: filter on optional pids
    let subWhere = [];
    if (bool(pids)) {
      subWhere = subWhere.concat(['fol."partnerId" IN (%s)']);
      whereParams.push(String(pids) || 'NULL');
    }
    else if (pids != null) {
      subWhere = subWhere.concat(['fol."partnerId" IS NULL'])
    }
    if (subWhere.length) {
      whereClause += f(" AND (%s)", subWhere.join(' OR '));
    }

    const query = f(`
      SELECT fol.id AS fid, fol."resId" AS rid, fol."partnerId" AS pid, array_agg(subtype.id)%s%s AS subids 
      FROM "mailFollowers" fol
      %s
      LEFT JOIN "mailFollowersMailMessageSubtypeRel" "folRel" ON "folRel"."mailFollowersId" = fol.id
      LEFT JOIN "mailMessageSubtype" subtype ON subtype.id = "folRel"."mailMessageSubtypeId"
      WHERE %s
      GROUP BY fol.id%s%s`,
      includePshare ? ', partner."partnerShare"' : '',
      includeActive ? ', partner.active' : '',
      (includePshare || includeActive) ? 'LEFT JOIN "resPartner" partner ON partner.id = fol."partnerId"' : '',
      whereClause,
      includePshare ? ', partner."partnerShare"' : '',
      includeActive ? ', partner.active' : ''
    );
    const res = await this.env.cr.execute(query, whereParams);
    return res;
  }
  // --------------------------------------------------
  // Private tools methods to generate new subscription
  // --------------------------------------------------

  /**
   * Main internal method allowing to create or update followers for documents, given a
      resModel and the document resIds. This method does not handle access rights. This is the
      role of the caller to ensure there is no security breach.

      :param subtypes: see ``_add_followers``. If not given, default ones are computed.
      :param customer_ids: see ``_add_default_followers``
      :param check_existing: see ``_add_followers``;
      :param existing_policy: see ``_add_followers``;
   * @param resModel 
   * @param resIds 
   * @param partnerIds 
   * @param options 
   */
  async _insertFollowers(resModel, resIds, partnerIds, options: {subtypes?: any, customerIds?: any, checkExisting?: boolean, existingPolicy?: string}={}) {
    setOptions(options, {checkExisting: true, existingPolicy: 'skip'});
    const sudoSelf = await (await this.sudo()).withContext({default_partnerId: false});
    let newObj, upd;
    if (!options.subtypes) { // no subtypes -> default computation, no force, skip existing
      [newObj, upd] = await this._addDefaultFollowers(
        resModel, resIds, partnerIds, options
      );
    }
    else {
      [newObj, upd] = await this._addFollowers(
        resModel, resIds, partnerIds, options.subtypes, options
      );
    }
    if (bool(newObj)) {
      const valsList = [];
      for (const [resId, valuesList] of Object.entries<any>(newObj)) {
        for (const values of valuesList) {
          valsList.push({...values, resId: resId})
        }
      }
      await sudoSelf.create(valsList);
    }
    for (const [folId, values] of Object.entries(upd)) {
      await sudoSelf.browse(folId).write(values);
    }
  }

  /**
   * Shortcut to ``_add_followers`` that computes default subtypes. Existing
    followers are skipped as their subscription is considered as more important
    compared to new default subscription.

    :param customer_ids: optional list of partner ids that are customers. It is used if computing
    default subtype is necessary and allow to avoid the check of partners being customers (no
    user or share user). It is just a matter of saving queries if the info is already known;
    :param check_existing: see ``_add_followers``;
    :param existing_policy: see ``_add_followers``;

    :return: see ``_add_followers``
   * @param resModel 
   * @param resIds 
   * @param partnerIds 
   * @param options 
   * @returns 
   */
  async _addDefaultFollowers(resModel, resIds, partnerIds?: any[], options: {customerIds?: any, checkExisting?: boolean, existingPolicy?: string}={}) {
    setOptions(options, {checkExisting: true, existingPolicy: 'skip'});
    if (!bool(partnerIds)) {
      return [{}, {}];
    }

    const [defaultValue, , external] = await this.env.items('mail.message.subtype').defaultSubtypes(resModel);
    if (bool(partnerIds) && options.customerIds == null) {
      options.customerIds = (await (await this.env.items('res.partner').sudo()).search([['id', 'in', partnerIds], ['partnerShare', '=', true]])).ids;
    }
    const pStypes = Object.fromEntries(partnerIds.map(pid => [pid, options.customerIds.includes(pid) ? external.ids : defaultValue.ids]));

    return this._addFollowers(resModel, resIds, partnerIds, pStypes, options);
  }

  /**
   * Internal method that generates values to insert or update followers. Callers have to
    handle the result, for example by making a valid ORM command, inserting or updating directly
    follower records, ... This method returns two main data

      * first one is a dict which keys are resIds. Value is a list of dict of values valid for
        creating new followers for the related resId;
      * second one is a dict which keys are follower ids. Value is a dict of values valid for
        updating the related follower record;

    :param subtypes: optional subtypes for new partner followers. This
      is a dict whose keys are partner IDs and value subtype IDs for that
      partner.
    :param channel_subtypes: optional subtypes for new channel followers. This
      is a dict whose keys are channel IDs and value subtype IDs for that
      channel.
    :param check_existing: if true, check for existing followers for given
      documents and handle them according to existing_policy parameter.
      Setting to false allows to save some computation if caller is sure
      there are no conflict for followers;
    :param existing policy: if check_existing, tells what to do with already
      existing followers:

      * skip: simply skip existing followers, do not touch them;
      * force: update existing with given subtypes only;
      * replace: replace existing with new subtypes (like force without old / new follower);
      * update: gives an update dict allowing to add missing subtypes (no subtype removal);
   * @param resModel 
   * @param resIds 
   * @param partnerIds 
   * @param subtypes 
   * @param options 
   * @returns 
   */
  async _addFollowers(resModel, resIds, partnerIds, subtypes, options: 
        {checkExisting?: boolean, existingPolicy?: string}={}) {
    options.existingPolicy = options.existingPolicy ?? 'skip';
    const _resIds = resIds ?? [0];
    const dataFols = {}
    const docPids = Object.fromEntries(_resIds.map(i => [i, new Set()]));

    if (options.checkExisting && resIds) {
      for (const {fid, rid, pid, subids} of await this._getSubscriptionData([[resModel, resIds]], partnerIds ?? null)) {
        if (options.existingPolicy !== 'force') {
          if (pid) {
            docPids[rid].add(pid);
          }
        }
        dataFols[fid] = [rid, pid, subids];
      }
      if (options.existingPolicy === 'force') {
        await (await this.sudo()).browse(Object.keys(dataFols)).unlink();
      }
    }
    const newObj = {}
    const update = {}
    for (const resId of _resIds) {
      for (const partnerId of new Set<number>(partnerIds ?? [])) {
        if (! docPids[resId].has(partnerId)) {
          setdefault(newObj, resId, []).push({
            'resModel': resModel,
            'partnerId': partnerId,
            'subtypeIds': [Command.set(subtypes[partnerId])],
          })
        }
        else if (['replace', 'update'].includes(options.existingPolicy)) {
          const [folId, sids] = next(Object.entries<any>(dataFols).filter(([key, val]) => val[0] == resId && val[1] == partnerId).map(([key, val]) => [key, val[2]]), [false, []]);
          // next(((key, val[2]) for key, val in data_fols.items() if val[0] == resId and val[1] == partnerId), (false, []))
          
          const newSids = _.difference<number>(subtypes[partnerId], sids);
          const oldSids = _.difference<number>(sids, subtypes[partnerId]);
          const updateCmd = [];
          if (folId && newSids.length) {
            updateCmd.concat(newSids.map(sid => Command.link(sid)));
          }
          if (folId && oldSids.length && options.existingPolicy === 'replace') {
            updateCmd.concat(oldSids.map(sid => Command.unlink(sid)));
          }
          if (updateCmd.length) {
            update[folId] = {'subtypeIds': updateCmd};
          }
        }
      }
    }
    return [newObj, update];
  }
}