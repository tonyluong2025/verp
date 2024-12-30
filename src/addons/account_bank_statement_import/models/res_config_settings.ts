import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"
import { getResourcePath } from "../../../core/modules";
import { b64encode, fileClose, fileOpen, fileRead } from "../../../core/tools";

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = "res.config.settings";
    static sampleImportCsv = Fields.Binary({default: '_defaultSampleImportCsv'});
    static sampleImportCsvName = Fields.Char({default: 'Import_Sample.csv'});
    static sampleImportExcel = Fields.Binary({default: '_defaultSampleSheetExcel'});
    static sampleImportExcelName = Fields.Char({default: 'Import_Sample.xlsx'});
    static fileName = Fields.Char('File', {size: 64});
    async _defaultSampleImportCsv() {
        const csvPath = getResourcePath('account_bank_statement_import', 'sample_files', 'Import_Sample.csv');
        const fd = fileOpen(csvPath, 'rb').fd;
        const data = fileRead(fd);
        fileClose(fd);
        return data.length && b64encode(data);
    }
    async _defaultSampleSheetExcel() {
        const csvPath = getResourcePath('account_bank_statement_import', 'sample_files', 'Import_Sample.xlsx');
        const fd = fileOpen(csvPath, 'rb').fd;
        const data = fileRead(fd);
        fileClose(fd);
        return data.length && b64encode(data);
    }
    async getSampleImportCsv() {
        return {
            'label': 'Bank Statement Sample CSV',
            'type': 'ir.actions.acturl',
            'url': ("web/content/?model=" + this._name + "&id=" +
                    String(this.id) + "&filenameField=sampleImportSheetName&" +
                                   "field=sampleImportSheet&download=true&" +
                                   "filename=Import_Sample.csv"),
            'target': 'self',
        }
    }
    async getSampleImportExcel() {
        return {
            'label': 'Bank Statement Sample Excel',
            'type': 'ir.actions.acturl',
            'url': ("web/content/?model=" + this._name + "&id=" +
                    String(this.id) + "&filenameField=sampleImportExcelName&" +
                                   "field=sampleImportExcel&download=true&"+
                                   "filename=Import_Sample.xlsx"),
            'target': 'self',
        }
    }
}