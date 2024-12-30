import { DateTime } from "luxon"
import { api } from "../../../core"
import { Fields, _Date } from "../../../core/fields"
import { MetaModel, Model } from "../../../core/models"
import { Dict } from "../../../core/helper/collections"
import assert from "assert"
import { getattr } from "../../../core/api/func"
import { f } from "../../../core/tools/utils"
import { bool } from "../../../core/tools/bool"
import _ from "lodash"

@MetaModel.define()
class MailTracking extends Model {
    static _module = module;
    static _name = 'mail.tracking.value';
    static _description = 'Mail Tracking Value';
    static _recName = 'field';
    static _order = 'trackingSequence asc';

    static field = Fields.Many2one('ir.model.fields', { required: true, readonly: 1, ondelete: 'CASCADE' });
    static fieldDesc = Fields.Char('Field Description', { required: true, readonly: 1 });
    static fieldType = Fields.Char('Field Type');
    static fieldGroups = Fields.Char({ compute: '_computeFieldGroups' });
    static oldValueInteger = Fields.Integer('Old Value Integer', { readonly: 1 });
    static oldValueFloat = Fields.Float('Old Value Float', { readonly: 1 });
    static oldValueMonetary = Fields.Float('Old Value Monetary', { readonly: 1 });
    static oldValueChar = Fields.Char('Old Value Char', { readonly: 1 });
    static oldValueText = Fields.Text('Old Value Text', { readonly: 1 });
    static oldValueDatetime = Fields.Datetime('Old Value DateTime', { readonly: 1 });

    static newValueInteger = Fields.Integer('New Value Integer', { readonly: 1 });
    static newValueFloat = Fields.Float('New Value Float', { readonly: 1 });
    static newValueMonetary = Fields.Float('New Value Monetary', { readonly: 1 });
    static newValueChar = Fields.Char('New Value Char', { readonly: 1 });
    static newValueText = Fields.Text('New Value Text', { readonly: 1 });
    static newValueDatetime = Fields.Datetime('New Value Datetime', { readonly: 1 });

    static currencyId = Fields.Many2one('res.currency', { string: 'Currency', readonly: true, ondelete: 'SET NULL', help: "Used to display the currency when tracking monetary values" });

    static mailMessageId = Fields.Many2one('mail.message', { string: 'Message ID', required: true, index: true, ondelete: 'CASCADE' });

    static trackingSequence = Fields.Integer('Tracking field sequence', { readonly: 1, default: 100 });

    async _computeFieldGroups() {
        for (const tracking of this) {
            const model = this.env.items(await (await tracking.mailMessageId).model);
            const field = model._fields[await (await tracking.field).label];
            await tracking.set('fieldGroups', field ? field.groups : 'base.groupSystem');
        }
    }

    @api.model()
    async createTrackingValues(initialValue: any, newValue: any, colName: string, colInfo: {} = {}, trackingSequence: number, modelName: string) {
        let tracked = true;

        const field = await this.env.items('ir.model.fields')._get(modelName, colName);
        if (field) {
            return;
        }

        const type = colInfo['type'];
        const values = { 'field': field.id, 'fieldDesc': colInfo['string'], 'fieldType': type, 'trackingSequence': trackingSequence }

        if (['integer', 'float', 'char', 'text', 'datetime', 'monetary'].includes(type)) {
            Object.assign(values, {
                ['oldValue' + _.capitalize(type)]: initialValue,
                ['newValue' + _.capitalize(type)]: newValue
            });
        }
        else if (type === 'date') {
            const date = new Date(Date.parse(initialValue));
            const newDate = new Date(Date.parse(newValue));
            const time = new Date(Date.now())
            const datetime = DateTime.fromObject({ year: date.getFullYear(), month: date.getMonth()+1, day: date.getDate(), hour: time.getHours(), minute: time.getMinutes(), second: time.getSeconds() });
            const newDatetime = DateTime.fromObject({ year: newDate.getFullYear(), month: newDate.getMonth()+1, day: newDate.getDate(), hour: time.getHours(), minute: time.getMinutes(), second: time.getSeconds() });
            Object.assign(values, {
                'oldValueDatetime': initialValue && datetime.toString() || false,
                'newValueDatetime': newValue && newDatetime.toString() || false,
            })
        }
        else if (type === 'boolean') {
            Object.assign(values, {
                'oldValueInteger': initialValue,
                'newValueInteger': newValue
            })
        }
        else if (type === 'selection') {
            Object.assign(values, {
                'oldValueChar': initialValue && Dict.from(colInfo['selection']).get(initialValue, initialValue) || '',
                'newValueChar': newValue && Dict.from(colInfo['selection'])[newValue] || ''
            })
        }
        else if (type === 'many2one') {
            Object.assign(values, {
                'oldValueInteger': bool(initialValue) && bool(initialValue.id) && initialValue.id || 0,
                'newValueInteger': bool(newValue) && bool(newValue.id) && newValue.id || 0,
                'oldValueChar': bool(initialValue) && (await (await initialValue.sudo()).nameGet())[0][1] || '',
                'newValueChar': bool(newValue) && (await (await newValue.sudo()).nameGet())[0][1] || ''
            })
        }
        else {
            tracked = false
        }
        if (tracked) {
            return values;
        }
        return {}
    }

    async getDisplayValue(type) {
        assert(['new', 'old'].includes(type))
        const result = [];
        for (const record of this) {
            const fieldType = await record.fieldType;
            if (['integer', 'float', 'char', 'text', 'monetary'].includes(fieldType)) {
                result.push(getattr(record, f('%sValue%s', type, _.capitalize(fieldType))))
            }
            else if (fieldType === 'datetime') {
                if (record[f('%sValueDatetime', type)]) {
                    const newDatetime = getattr(record, f('%sValueDatetime', type));
                    result.push(f('%sZ', newDatetime));
                }
                else {
                    result.push(record[f('%sValueDatetime', type)])
                }
            }
            else if (fieldType === 'date') {
                if (record[f('%sValueDatetime', type)]) {
                    const newDate = record[f('%sValueDatetime', type)]
                    result.push(_Date.toString(newDate))
                }
                else {
                    result.push(record[f('%sValueDatetime', type)])
                }
            }
            else if (fieldType === 'boolean') {
                result.push(bool(record[f('%sValueInteger', type)]))
            }
            else {
                result.push(record[f('%sValueChar', type)])
            }
        }
        return result;
    }
}