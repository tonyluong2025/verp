import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { ValidationError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { bool } from "../../../core/tools/bool";
import { extend, len } from "../../../core/tools/iterable";
import { pop } from "../../../core/tools/misc";
import { _f } from "../../../core/tools/utils";

@MetaModel.define()
class AccountTaxReport extends Model {
  static _module = module;
  static _name = "account.tax.report";
  static _description = 'Account Tax Report';
  static _order = 'countryId, label';

  static label = Fields.Char({ string: "Name", required: true, help: "Name of this tax report" });
  static countryId = Fields.Many2one({ string: "Country", comodelName: 'res.country', required: true, default: async (x) => (await (await x.env.company()).countryId).id, help: "Country for which this report is available." });
  static lineIds = Fields.One2many('account.tax.report.line', 'reportId', { string: "Report Lines", help: "Content of this tax report" });
  static rootLineIds = Fields.One2many('account.tax.report.line', 'reportId', { string: "Root Report Lines", domain: [['parentId', '=', null]], help: "Subset of lineIds, containing the lines at the root of the report." });

  async write(vals) {
    // Overridden so that we change the country _id of the existing tags
    // when writing the countryId of the report, or create new tags
    // for the new country if the tags are shared with some other report.

    if ('countryId' in vals) {
      const tagsCache = {};
      for (const record of await this.filtered(async (x) => (await x.countryId).id != vals['countryId'])) {
        for (const line of await record.lineIds) {
          const [tagName, tagIds] = await line('tagName', 'tagIds');
          if (tagIds.ok) {
            //The tags for this country may have been created by a previous line in this loop
            const cacheKey = [vals['countryId'], tagName].join('@');
            if (!(cacheKey in tagsCache)) {
              tagsCache[cacheKey] = this.env.items('account.account.tag')._getTaxTags(tagName, vals['countryId']);
            }

            const newTags = tagsCache[cacheKey];
            const self = this;
            if (newTags) {
              await line._removeTagsUsedOnlyBySelf();
              await line.write({ 'tagIds': [[6, 0, newTags.ids]] });
            }
            else if (bool(await (await line.mapped('tagIds.taxReportLineIds.reportId')).filtered((x) => !self.includes(x)))) {
              await line._removeTagsUsedOnlyBySelf();
              await line.write({ 'tagIds': [[5, 0, 0]].concat(await line._getTagsCreateVals(tagName, vals['countryId'])) });
              tagsCache[cacheKey] = tagIds;
            }
            else {
              await tagIds.write({ 'countryId': vals['countryId'] });
            }
          }
        }
      }
    }
    return _super(AccountTaxReport, this).write(vals);
  }

  async copy(defaultValue?: any) {
    // Overridden from regular copy, since the ORM does not manage
    // the copy of the lines hierarchy properly (all the parentId fields
    // need to be reassigned to the corresponding copies).

    const copyDefault = defaultValue ? Object.fromEntries(Object.entries(defaultValue).filter(([k, v]) => k !== 'lineIds')) : null;
    const copiedReport = await _super(AccountTaxReport, this).copy(copyDefault); //This copies the report without its lines

    const linesMap = {}; // maps original lines to their copies (using ids)
    const linesToTreat = Array.from<any>(await (await this['lineIds']).filtered(async (x) => ! await x.parentId));
    while (linesToTreat.length) {
      const line = linesToTreat.pop();
      extend(linesToTreat, Array.from(await line.childrenLineIds));

      const copy = await line.copy({ 'parentId': linesMap[(await line.parentId).id] ?? null, 'reportId': copiedReport.id });
      linesMap[line.id] = copy.id;
    }
    return copiedReport;
  }

  /**
   * Returns an interator to the lines of this tax report, were parent lines
      ar all directly followed by their children.
   */
  async *getLinesInHierarchy() {
    this.ensureOne();
    let linesToTreat = Array.from<any>(await (await (await this['lineIds']).filtered(async (x) => ! await x.parentId)).sorted(x => x.sequence)); // Used as a stack, whose index 0 is the top
    while (linesToTreat.length) {
      const toYield = linesToTreat[0];
      linesToTreat = Array.from(await (await toYield['childrenLineIds']).sorted(x => x.sequence)).concat(linesToTreat.slice(1));
      yield toYield;
    }
  }

  /**
   * To override in localizations
      If value is a float, it will be formatted with format_value
      The line is not displayed if it is falsy (0, 0.0, false, ...)
      :param amounts: the mapping dictionary between codes and values
      :param carried_over: the mapping dictionary between codes and whether they are carried over
      :return: iterable of tuple (name, value)
   * @param amounts 
   * @param carriedOver 
   * @returns 
   */
  async getChecksToPerform(amounts, carriedOver) {
    this.ensureOne();
    return [];
  }

  async validateCountryId() {
    for (const record of this) {
      if (await (await record['lineIds']).some(async line =>
        !(await (await line['tagIds']).mapped('countryId')).eq(await record.countryId)
      )) {
        throw new ValidationError(await this._t("The tags associated with tax report line objects should all have the same country set as the tax report containing these lines."));
      }
    }
  }
}

@MetaModel.define()
class AccountTaxReportLine extends Model {
  static _module = module;
  static _name = "account.tax.report.line";
  static _description = 'Account Tax Report Line';
  static _order = 'sequence';
  static _parentStore = true;

  static label = Fields.Char({ string: "Name", required: true, help: "Complete name for this report line, to be used in report." });
  static tagIds = Fields.Many2many({ string: "Tags", comodelName: 'account.account.tag', relation: 'accountTaxReportLineTagsRel', help: "Tax tags populating this line" });
  static reportActionId = Fields.Many2one({ string: "Report Action", comodelName: 'ir.actions.actwindow', help: "The optional action to call when clicking on this line in accounting reports." });
  static childrenLineIds = Fields.One2many('account.tax.report.line', 'parentId', { string: "Children Lines", help: "Lines that should be rendered as children of this one" });
  static parentId = Fields.Many2one({ string: "Parent Line", comodelName: 'account.tax.report.line' });
  static sequence = Fields.Integer({ string: 'Sequence', required: true, help: "Sequence determining the order of the lines in the report (smaller ones come first). This order is applied locally per section (so, children of the same line are always rendered one after the other)." });
  static parentPath = Fields.Char({ index: true });
  static reportId = Fields.Many2one({ string: "Tax Report", required: true, comodelName: 'account.tax.report', ondelete: 'CASCADE', help: "The parent tax report of this line" });

  // helper to create tags (positive and negative) on report line creation
  static tagName = Fields.Char({ string: "Tag Name", help: "Short name for the tax grid corresponding to this report line. Leave empty if this report line should not correspond to any such grid." });

  // fields used in specific localization reports, where a report line isn't simply the given by the sum of account.move.line with selected tags
  static code = Fields.Char({ string: "Code", help: "Optional unique code to refer to this line in total formulas" });
  static formula = Fields.Char({ string: "Formula", help: "Javascript expression used to compute the value of a total line. This field is mutually exclusive with tagName, setting it turns the line to a total line. Tax report line codes can be used as variables in this expression to refer to the balance of the corresponding lines in the report. A formula cannot refer to another line using a formula." });

  // fields used to carry over amounts between periods

  // The selection should be filled in localizations using the system
  static carryOverConditionMethod = Fields.Selection({
    selection: [
      ['noNegativeAmountCarryOverCondition', 'No negative amount'],
      ['alwaysCarryOverAndSetTo0', 'Always carry over and set to 0'],
    ],
    string: "Method",
    help: "The method used to determine if this line should be carried over."
  });
  static carryOverDestinationLineId = Fields.Many2one({
    string: "Destination",
    comodelName: "account.tax.report.line",
    domain: "[['reportId', '=', reportId]]",
    help: "The line to which the value of this line will be carried over to if needed. If left empty the line will carry over to itself."
  });
  static carryoverLineIds = Fields.One2many('account.tax.carryover.line', 'taxReportLineId', {
    string: "Carryover lines",
  });
  static isCarryoverPersistent = Fields.Boolean({
    string: "Persistent",
    help: ["Defines how this report line creates carry over lines when performing tax closing.",
      "If true, the amounts carried over will always be added on top of each other: ",
      "for example, a report line with a balance of 10 with an existing carryover of 50 ",
      "will add an additional 10 to it when doing the closing, making a total carryover of 60. ",
      "If false, the total carried over amount will be forced to the total of this report line: ",
      "a report line with a balance of 10 with an existing carryover of 50 will create a new ",
      "carryover line of -40, so that the total carryover becomes 10."].join('\n'),
    default: true,
  });
  static isCarryoverUsedInBalance = Fields.Boolean({
    string: "Used in line balance",
    help: "If set, the carryover amount for this line will be used when calculating its balance in the report. This means that the carryover could affect other lines if they are using this one in their computation."
  });

  @api.model()
  async create(vals) {
    // Manage tags
    const tagName = vals['tagName'] || '';
    if (tagName && vals['reportId']) {
      const report = this.env.items('account.tax.report').browse(vals['reportId']);
      const country = await report.countryId;

      const existingTags = this.env.items('account.account.tag')._getTaxTags(tagName, country.id);

      if (bool(existingTags)) {
        // We connect the new report line to the already existing tags
        vals['tagIds'] = [[6, 0, existingTags.ids]];
      }
      else {
        // We create new ones
        vals['tagIds'] = this._getTagsCreateVals(tagName, country.id);
      }
    }

    return _super(AccountTaxReportLine, this).create(vals);
  }

  @api.model()
  _getTagsCreateVals(tagName, countryId): any[][] {
    const minusTagVals = {
      'label': '-' + tagName,
      'applicability': 'taxes',
      'taxNegate': true,
      'countryId': countryId,
    }
    const plusTagVals = {
      'label': '+' + tagName,
      'applicability': 'taxes',
      'taxNegate': false,
      'countryId': countryId,
    }
    return [[0, 0, minusTagVals], [0, 0, plusTagVals]];
  }

  async write(vals) {
    let tagNamePostponed;// = None

    // If tagName was set, but not tagIds, we postpone the write of
    // tagName, and perform it only after having generated/retrieved the tags.
    // Otherwise, tagName and tags' name would not match, breaking
    // _validate_tags constaint.
    const postponeTagName = ('tagName' in vals) && !('tagIds' in vals);

    if (postponeTagName) {
      tagNamePostponed = pop(vals, 'tagName');
    }

    const rslt = await _super(AccountTaxReportLine, this).write(vals);

    if (postponeTagName) {
      // If tagName modification has been postponed,
      // we need to search for existing tags corresponding to the new tag name
      // (or create them if they don't exist yet) and assign them to the records

      const recordsByCountry = {};
      for (const record of await this.filtered(async (x) => await x.tagName !== tagNamePostponed)) {
        const id = (await (await record.reportId).countryId).id;
        recordsByCountry[id] = (recordsByCountry[id] ?? this.env.items('account.tax.report.line')).add(record);
      }

      for (const [countryId, records] of Object.entries<any>(recordsByCountry)) {
        if (tagNamePostponed) {
          const recordTagNames = await records.mapped('tagName');
          if (len(recordTagNames) == 1 && recordTagNames[0]) {
            // If all the records already have the same tagName before writing,
            // we simply want to change the name of the existing tags
            const toUpdate = await records.mapped('tagIds.taxReportLineIds');
            const tagsToUpdate = await toUpdate.mapped('tagIds');
            const minusChildTags = await tagsToUpdate.filtered((x) => x.taxNegate);
            await minusChildTags.write({ 'label': '-' + tagNamePostponed });
            const plusChildTags = await tagsToUpdate.filtered(async (x) => ! await x.taxNegate);
            await plusChildTags.write({ 'label': '+' + tagNamePostponed });
            await _super(AccountTaxReportLine, toUpdate).write({ 'tagName': tagNamePostponed });
          }
          else {
            let existingTags = await this.env.items('account.account.tag')._getTaxTags(tagNamePostponed, countryId);
            let recordsToLink = records;
            let tagsToRemove = this.env.items('account.account.tag');

            if (!existingTags && recordsToLink.ok) {
              // If the tag does not exist yet, we first create it by
              // linking it to the first report line of the record set
              const firstRecord = recordsToLink[0];
              tagsToRemove = tagsToRemove.add(await firstRecord.tagIds);
              await firstRecord.write({ 'tagName': tagNamePostponed, 'tagIds': [[5, 0, 0]].concat(this._getTagsCreateVals(tagNamePostponed, countryId)) });
              existingTags = await firstRecord.tagIds;
              recordsToLink = recordsToLink.sub(firstRecord);
            }
            // All the lines sharing their tags must always be synchronized,
            tagsToRemove = tagsToRemove.add(await recordsToLink.mapped('tagIds'));
            recordsToLink = await tagsToRemove.mapped('taxReportLineIds');
            await (await tagsToRemove.mapped('taxReportLineIds'))._removeTagsUsedOnlyBySelf();
            await recordsToLink.write({ 'tagName': tagNamePostponed, 'tagIds': (await tagsToRemove.map(tag => [2, tag.id])).concat([[6, 0, existingTags.ids]]) });
          }
        }
        else {
          // tagName was set empty, so we remove the tags on current lines
          // If some tags are still referenced by other report lines,
          // we keep them ; else, we delete them from DB
          const lineTags = await records.mapped('tagIds');
          const otherLinesSameTag = await (await lineTags.mapped('taxReportLineIds')).filtered(async (x) => !records.includes(x));
          if (!otherLinesSameTag.ok) {
            await this._deleteTagsFromTaxes(lineTags.ids);
          }
          const ormCmdCode = otherLinesSameTag.ok && 3 || 2;
          await records.write({ 'tagName': null, 'tagIds': await lineTags.map(tag => [ormCmdCode, tag.id]) });
        }
      }
    }
    return rslt;
  }

  async unlink() {
    await this._removeTagsUsedOnlyBySelf();
    const children = await this.mapped('childrenLineIds');
    if (children.ok) {
      await children.unlink();
    }
    return _super(AccountTaxReportLine, this).unlink();
  }

  /**
   * Deletes and removes from taxes and move lines all the
      tags from the provided tax report lines that are not linked
      to any other tax report lines.
   */
  async _removeTagsUsedOnlyBySelf() {
    const allTags = await this.mapped('tagIds');
    const tagsToUnlink = await allTags.filtered(async (x) => !(await x.taxReportLineIds).sub(this).ok);
    await this.write({ 'tagIds': await tagsToUnlink.map(tag => [3, tag.id, 0]) });
    await this._deleteTagsFromTaxes(tagsToUnlink.ids);
  }

  /**
   * Based on a list of tag ids, removes them first from the
      repartition lines they are linked to, then deletes them
      from the account move lines, and finally unlink them.
   * @param tagIdsToDelete 
   * @returns 
   */
  @api.model()
  async _deleteTagsFromTaxes(tagIdsToDelete) {
    if (!bool(tagIdsToDelete)) {
      // Nothing to do, then!
      return;
    }
    await this.env.cr.execute(_f(`
                delete from "accountAccountTagAccountTaxRepartitionLineRel"
                where "accountAccountTagId" in ({tagIdsToDelete});
    
                delete from "accountAccountTagAccountMoveLineRel"
                where "accountAccountTagId" in ({tagIdsToDelete});
            `, { 'tagIdsToDelete': String(tagIdsToDelete) }));

    this.env.items('account.move.line').invalidateCache(['taxTagIds']);
    this.env.items('account.tax.repartition.line').invalidateCache(['tagIds']);

    await this.env.items('account.account.tag').browse(tagIdsToDelete).unlink();
  }

  @api.constrains('formula', 'tagName')
  async _validateFormula() {
    for (const record of this) {
      if (await record.formula && await record.tagName) {
        throw new ValidationError(await this._t("Tag name and formula are mutually exclusive, they should not be set together on the same tax report line."));
      }
    }
  }

  @api.constrains('tagName', 'tagIds')
  async _validateTags() {
    for (const record of await this.filtered(async (x) => bool(await x.tagIds))) {
      const [tagIds, tagName] = await record('tagIds', 'tagName');
      const negTags = await tagIds.filtered((x) => x.taxNegate);
      const posTags = await tagIds.filtered(async (x) => ! await x.taxNegate);

      if (len(negTags) != 1 || len(posTags) != 1) {
        throw new ValidationError(await this._t("If tags are defined for a tax report line, only two are allowed on it: a positive and a negative one."));
      }

      if ((await negTags.label !== '-' + tagName) || (await posTags.label != '+' + tagName)) {
        throw new ValidationError(await this._t("The tags linked to a tax report line should always match its tag name."));
      }
    }
  }

  /**
   * Action when clicking on the "View carryover lines" in the carryover info popup.
      Takes into account the report options, to get the correct lines depending on the current
      company/companies.
 
      :return:    An action showing the account.tax.carryover.lines for the current tax report line.
   * @param options 
   * @returns 
   */
  async actionViewCarryoverLines(options) {
    this.ensureOne();

    const target = await this._getCarryoverDestinationLine(options);
    const domain = await target._getCarryoverLinesDomain(options);
    const carryoverLines = await this.env.items('account.tax.carryover.line').search(domain);

    return {
      'type': 'ir.actions.actwindow',
      'label': await this._t('Carryover Lines For %s', await target.label),
      'resModel': 'account.tax.carryover.line',
      'viewType': 'list',
      'viewMode': 'list',
      'views': [[(await this.env.ref('account.accountTaxCarryoverLineTree')).id, 'list'],
      [false, 'form']],
      'domain': [['id', 'in', carryoverLines.ids]],
    }
  }

  /**
   * Check if the line will be carried over, by checking the condition method set on the line.
      Do not override this method, but instead set your condition methods on each lines.
      :param options: The options of the reports
      :param line_amount: The amount on the line
      :param carried_over_amount: The amount carried over for this line
      :return: A tuple containing the lower and upper bounds from which the line will be carried over.
      E.g. (0, 42) : Lines which value is below 0 or above 42 will be carried over.
      E.g. (0, None) : Only lines which value is below 0 will be carried over.
      E.g. None : This line will never be carried over.
   * @param options 
   * @param lineAmount 
   * @param carriedOverAmount 
   */
  async _getCarryoverBounds(options, lineAmount, carriedOverAmount) {
    this.ensureOne();
    // Carry over is disabled by default, but if there is a carry over condition  method on the line we are
    // calling it first. That way we can have a default carryover condition for the whole report (carryover_bounds)
    // and specialized condition for specific lines if needed
    const carryOverConditionMethod = await this['carryOverConditionMethod'];
    if (carryOverConditionMethod) {
      const conditionMethod = this[carryOverConditionMethod] ?? false;
      if (conditionMethod) {
        return conditionMethod.call(this, options, lineAmount, carriedOverAmount);
      }
    }
    return null;
  }

  /**
   * :param options: The report options
      :return: The domain that can be used to search for carryover lines for this tax report line.
      Using this domain instead of directly accessing the lines ensure that we only pick the ones related to the
      companies affecting the tax report.
   * @param options 
   */
  async _getCarryoverLinesDomain(options) {
    this.ensureOne();
    let domain = [['taxReportLineId', '=', this.id]];

    if (options['multiCompany']) {
      const companyIds = options['multiCompany'].map(company => company['id']);
      domain = expression.AND([domain, [['companyId', 'in', companyIds]]]);
    }
    else {
      domain = expression.AND([domain, [['companyId', '=', (await this.env.company()).id]]])
    }
    return domain;
  }

  noNegativeAmountCarryOverCondition(options, lineAmount, carriedOverAmount) {
    // The bounds are [0, null].
    // Lines below 0 will be set to 0 and reduce the balance of the carryover.
    // Lines above 0 will never be carried over
    return [0, null];
  }

  alwaysCarryOverAndSetTo0(options, lineAmount, carriedOverAmount) {
    // The bounds are [0, 0].
    // Lines below 0 will be set to 0 and reduce the balance of the carryover.
    // Lines above 0 will be set to 0 and increase the balance of the carryover.
    return [0, 0];
  }

  /**
   * Return the destination line for the carryover for this tax report line.
      :param options: The options of the tax report.
      :return: The line on which we'll carryover this tax report line when closing the tax period.
   * @param options 
   * @returns 
   */
  async _getCarryoverDestinationLine(options) {
    this.ensureOne();
    const carryOverDestinationLineId = await this['carryOverDestinationLineId'];
    return carryOverDestinationLineId.ok ? carryOverDestinationLineId : this;
  }
}