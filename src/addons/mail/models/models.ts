import _ from "lodash";
import { api } from "../../../core";
import { getattr } from "../../../core/api/func";
import { Dict } from "../../../core/helper/collections";
import { ValueError } from "../../../core/helper/errors";
import { AbstractModel, MetaModel, _super } from "../../../core/models";
import { bool, emailNormalizeAll, f, formataddr, len, repr } from "../../../core/tools";
import { E } from "../../../core/tools/xml";

@MetaModel.define()
class BaseModel extends AbstractModel {
  static _module = module;
  static _parents = 'base';

  _validFieldParameter(field, name) {
    // allow specifying rendering options directly from field when using the render mixin
    return (name === 'tracking' && this.cls._abstract
      || _super(BaseModel, this)._validFieldParameter(field, name)
    );
  }

  // ------------------------------------------------------------
  // GENERIC MAIL FEATURES
  // ------------------------------------------------------------

  /**
   * For a given record, fields to check (tuple column name, column info)
      and initial values, return a valid command to create tracking values.
 
      :param tracked_fields: fieldsGet of updated fields on which tracking
        is checked and performed;
      :param initial: dict of initial values for each updated fields;
 
      :return: a tuple (changes, tracking_value_ids) where
        changes: set of updated column names;
        tracking_value_ids: a list of ORM (0, 0, values) commands to create
        ``mail.tracking.value`` records;
 
      Override this method on a specific model to implement model-specific
      behavior. Also consider inheriting from ``mail.thread``.
   * @param trackedFields 
   * @param initial 
   * @returns 
   */
  async _mailTrack(trackedFields: {}, initial: {}) {
    this.ensureOne();
    const changes = new Set();  // contains onchange tracked fields that changed
    const trackingValueIds = [];

    // generate tracked_values data structure: {'col_name': {col_info, new_value, old_value}}
    for (const [colName, colInfo] of Object.entries(trackedFields)) {
      if (!(colName in initial)) {
        continue;
      }
      const initialValue = initial[colName];
      const newValue = await this[colName];

      if (newValue != initialValue && (newValue || initialValue)) {  // because browse null != false
        let trackingSequence = getattr(this._fields[colName], 'tracking',
          getattr(this._fields[colName], 'track_sequence', 100));  // backward compatibility with old parameter name
        if (trackingSequence === true) {
          trackingSequence = 100;
        }
        const tracking = await this.env.items('mail.tracking.value').createTrackingValues(initialValue, newValue, colName, colInfo, trackingSequence, this._name);
        if (bool(tracking)) {
          if (tracking['fieldType'] === 'monetary') {
            tracking['currencyId'] = (await this[colInfo['currencyField']]).id;
          }
          trackingValueIds.push([0, 0, tracking]);
        }
        changes.add(colName);
      }
    }
    return [Array.from(changes), trackingValueIds];
  }

  /**
   * Generic implementation for finding default recipient to mail on
      a recordset. This method is a generic implementation available for
      all models as we could send an email through mail templates on models
      not inheriting from mail.thread.
 
      Override this method on a specific model to implement model-specific
      behavior. Also consider inheriting from ``mail.thread``.
   */
  async _messageGetDefaultRecipients() {
    const res = {}
    for (const record of this) {
      const partnerId = await record.partnerId;
      let [recipientIds, emailTo, emailCc] = [[], false, false];
      let foundEmail;
      if ('partnerId' in record && partnerId.ok) {
        recipientIds.push(partnerId.id);
      }
      else {
        foundEmail = false;
        if ('emailFrom' in record._fields) {
          const emailFrom = await record.emailFrom;
          if (emailFrom) {
            foundEmail = emailFrom;
          }
        }
        else if ('partnerEmail' in record._fields) {
          const partnerEmail = await record.partnerEmail;
          if (partnerEmail) {
            foundEmail = partnerEmail;
          }
        }
        else if ('email' in record._fields) {
          const email = await record.email;
          if (email) {
            foundEmail = email;
          }
        }
        else if ('emailNormalized' in record._fields) {
          const emailNormalized = await record.emailNormalized;
          if (emailNormalized) {
            foundEmail = emailNormalized;
          }
        }
        let emailTo;
        if (foundEmail) {
          emailTo = emailNormalizeAll(foundEmail).join(',');
        }
        if (!emailTo) {  // keep value to ease debug / trace update
          emailTo = foundEmail;
        }
      }
      res[record.id] = { 'partnerIds': recipientIds, 'emailTo': emailTo, 'emailCc': emailCc };
    }
    return res;
  }

  /**
   * Returns the preferred reply-to email address when replying to a thread
      on documents. This method is a generic implementation available for
      all models as we could send an email through mail templates on models
      not inheriting from mail.thread.
 
      Reply-to is formatted like "MyCompany MyDocument <reply.to@domain>".
      Heuristic it the following:
       * search for specific aliases as they always have priority; it is limited
         to aliases linked to documents (like project alias for task for example);
       * use catchall address;
       * use default;
 
      This method can be used as a generic tools if self is a void recordset.
 
      Override this method on a specific model to implement model-specific
      behavior. Also consider inheriting from ``mail.thread``.
      An example would be tasks taking their reply-to alias from their project.
 
      :param default: default email if no alias or catchall is found;
      :param records: DEPRECATED, self should be a valid record set or an
        empty recordset if a generic reply-to is required;
      :param company: used to compute company name part of the from name; provide
        it if already known, otherwise use records company it they all belong to the same company
        and fall back on user's company in mixed companies environments;
      :param doc_names: dict(resId, doc_name) used to compute doc name part of
        the from name; provide it if already known to avoid queries, otherwise
        name_get on document will be performed;
      :return result: dictionary. Keys are record IDs and value is formatted
        like an email "Company_name Document_name <reply_to@email>"/
   * @param defaultValue 
   * @param records 
   * @param company 
   * @param docNames 
   */
  async _notifyGetReplyTo(defaultValue, records?: any, company?: any, docNames?: any) {
    if (bool(records)) {
      throw new ValueError('Use of records is deprecated as this method is available on BaseModel.');
    }
    let _records = this;
    const model = _records.ok && _records._name !== 'mail.thread' ? _records._name : false;
    const resIds = _records.ok && model ? _records.ids : [];
    const _resIds = bool(resIds) ? resIds : [false];  // always have a default value located in false

    const aliasDomain = await (await this.env.items('ir.config.parameter').sudo()).getParam("mail.catchall.domain");
    const result = Dict.fromKeys(_resIds, false);
    const resultEmail = new Dict();
    docNames = docNames ? docNames : new Dict();
    let leftIds;
    if (bool(aliasDomain)) {
      if (model && bool(resIds)) {
        if (!bool(docNames)) {
          docNames = new Dict(await _records.map(async (rec) => [rec.id, await rec.displayName]));
        }
        if (!bool(company) && 'companyId' in this._fields && len(await this['companyId']) == 1) {
          company = await this['companyId'];
        }

        const mailAliases = await (await this.env.items('mail.alias').sudo()).search([
          ['aliasParentModelId.model', '=', model],
          ['aliasParentThreadId', 'in', resIds],
          ['aliasName', '!=', false]]);
        // take only first found alias for each threadId, to match order (1 found -> limit=1 for each resId)
        for (const alias of mailAliases) {
          resultEmail.setdefault(await alias.aliasParentThreadId, f('%s@%s', await alias.aliasName, aliasDomain));
        }
      }
      // left ids: use catchall
      leftIds = _.difference(_resIds, resultEmail);
      if (leftIds.length) {
        const catchall = await (await this.env.items('ir.config.parameter').sudo()).getParam("mail.catchall.alias");
        if (bool(catchall)) {
          resultEmail.update(new Dict(leftIds.map(rid => [rid, f('%s@%s', catchall, aliasDomain)])));
        }
      }
      for (const resId of Object.keys(resultEmail)) {
        result[resId] = await this._notifyGetReplyToFormattedEmail(
          resultEmail[resId],
          docNames[resId] || '',
          company
        );
      }
    }
    leftIds = _.difference(_resIds, resultEmail);
    if (leftIds.length) {
      result.updateFrom(new Dict(leftIds.map(resId => [resId, defaultValue])));
    }

    return result;
  }

  /**
   * Compute formatted email for reply_to and try to avoid refold issue
        with code that splits the reply-to over multiple lines. It is due to
        a bad management of quotes (missing quotes after refold). This appears
        therefore only when having quotes (aka not simple names, and not when
        being unicode encoded).
 
        To avoid that issue when formataddr would return more than 78 chars we
        return a simplified name/email to try to stay under 78 chars. If not
        possible we return only the email and skip the formataddr which causes
        the issue. We do not use hacks like crop the name part as
        encoding and quoting would be error prone.
   */
  async _notifyGetReplyToFormattedEmail(recordEmail, recordName, company) {
    // address itself is too long for 78 chars limit: return only email
    if (len(recordEmail) >= 78) {
      return recordEmail;
    }

    const companyName = bool(company) ? await company.label : await (await this.env.company()).label;

    // try company_name + record_name, or record_name alone (or company_name alone)
    const label = recordName ? "{companyName} {recordName}" : companyName;

    let formattedEmail = formataddr([label, recordEmail]);
    if (len(formattedEmail) > 78) {
      formattedEmail = formataddr([recordName || companyName, recordEmail]);
    }
    if (len(formattedEmail) > 78) {
      formattedEmail = recordEmail;
    }
    return formattedEmail;
  }

  // ------------------------------------------------------------
  // ALIAS MANAGEMENT
  // ------------------------------------------------------------

  /**
   * Generic method that takes a record not necessarily inheriting from
      mail.alias.mixin.
   */
  async _aliasGetErrorMessage(message, messageDict, alias) {
    const author = this.env.items('res.partner').browse(messageDict['authorId'] || false);
    if (await alias.aliasContact === 'followers') {
      if (!bool(this.ids)) {
        return this._t('incorrectly configured alias (unknown reference record)');
      }
      if (!this._fields["messagePartnerIds"]) {
        return this._t('incorrectly configured alias');
      }
      if (!author.ok || !(await this['messagePartnerIds']).includes(author)) {
        return this._t('restricted to followers');
      }
    }
    else if (await alias.aliasContact === 'partners' && !author.ok) {
      return this._t('restricted to known authors');
    }
    return false;
  }

  // ------------------------------------------------------------
  // ACTIVITY
  // ------------------------------------------------------------

  /**
   * Generates an empty activity view.
 
      :returns: a activity view as an lxml document
      :rtype: etree._Element
   */
  @api.model()
  async _getDefaultActivityView() {
    const field = E.field({ name: await this._recNameFallback() });
    const activityBox = E.div(field, { 't-name': "activity-box" });
    const templates = E.withType('templates', activityBox);
    return E.withType('activity', templates, { string: this.cls._description });
  }
  
  // ------------------------------------------------------------
  // GATEWAY: NOTIFICATION
  // ------------------------------------------------------------

  async _mailGetMessageSubtypes() {
    return this.env.items('mail.message.subtype').search([
      '&', ['hidden', '=', false],
      '|', ['resModel', '=', this._name], ['resModel', '=', false]]);
  }

  /**
   * Generate the email headers based on record
   * @returns 
   */
  _notifyEmailHeaders() {
    if (!this.ok) {
      return {};
    }
    this.ensureOne();
    return repr(this._notifyEmailHeaderDict());
  }

  _notifyEmailHeaderDict() {
    return {
      'X-Verp-Objects': f("%s-%s", this._name, this.id),
    }
  }
}