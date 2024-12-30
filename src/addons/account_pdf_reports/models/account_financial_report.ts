import { Fields, api } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class AccountFinancialReport extends Model {
    static _module = module;
    static _name = "account.financial.report";
    static _description = "Account Report";

    /**
     * Returns a dictionary with key=the ID of a record and value = the level of this
           record in the tree structure.
     */
    @api.depends('parentId', 'parentId.level')
    async _getLevel() {
        for (const report of this) {
            let level = 0;
            const parentId = await report.parentId;
            if (parentId.ok) {
                level = await parentId.level + 1;
            }
            await report.set('level', level);
        }
    }

    /**
     * returns a recordset of all the children computed recursively, and sorted by sequence. Ready for the printing
     * @returns 
     */
    async _getChildrenByOrder() {
        let res = this;
        const children = await this.search([['parentId', 'in', this.ids]], {order: 'sequence ASC'});
        if (children.ok) {
            for (const child of children) {
                res = res.add(await child._getChildrenByOrder());
            }
        }
        return res;
    }

    static label = Fields.Char('Report Name', {required: true, translate: true});
    static parentId = Fields.Many2one('account.financial.report', {string: 'Parent'});
    static childrenIds = Fields.One2many('account.financial.report', 'parentId', { string: 'Children'});
    static sequence = Fields.Integer('Sequence');
    static level = Fields.Integer({compute: '_getLevel', string: 'Level', store: true, recursive: true});
    static type = Fields.Selection([
        ['sum', 'View'],
        ['accounts', 'Accounts'],
        ['accountType', 'Account Type'],
        ['accountReport', 'Report Value'],
        ], {string: 'Type', default: 'sum'});
    static accountIds = Fields.Many2many('account.account', {relation: 'accountAccountFinancialReport', column1: 'reportLineId', column2: 'accountId', string: 'Accounts'});
    static accountReportId = Fields.Many2one('account.financial.report', {string: 'Report Value'});
    static accountTypeIds = Fields.Many2many('account.account.type', {relation: 'accountAccountFinancialReportType', column1: 'reportId', column2: 'accountTypeId', string: 'Account Types'});
    static sign = Fields.Selection([['-1', 'Reverse balance sign'], ['1', 'Preserve balance sign']], {string: 'Sign on Reports', required: true, default: '1',
        help: ['For accounts that are typically more debited than credited and that you would',
                ' like to print as negative amounts in your reports, you should reverse the sign',
                ' of the balance; e.g.: Expense account. The same applies for accounts that are ',
                'typically more credited than debited and that you would like to print as positive ',
                'amounts in your reports; e.g.: Income account.'].join()});
    static displayDetail = Fields.Selection([
        ['noDetail', 'No detail'],
        ['detailFlat', 'Display children flat'],
        ['detailWithHierarchy', 'Display children with hierarchy']
        ], {string: 'Display details', default: 'detailFlat'});
    static styleOverwrite = Fields.Selection([
        ['0', 'Automatic formatting'],
        ['1', 'Main Title 1 (bold, underlined)'],
        ['2', 'Title 2 (bold)'],
        ['3', 'Title 3 (bold, smaller)'],
        ['4', 'Normal Text'],
        ['5', 'Italic Text (smaller)'],
        ['6', 'Smallest Text'],
        ], {string: 'Financial Report Style', default: '0',
        help: ["You can set up here the format you want this record to be displayed. ",
             "If you leave the automatic formatting, it will be computed based on the ",
             "financial reports hierarchy (auto-computed field 'level')."].join()});
}