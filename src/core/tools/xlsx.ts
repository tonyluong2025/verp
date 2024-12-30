import * as ExcelJS from 'exceljs';
import { UserError } from '../helper';
import { toText } from './compat';
import { doWithSync, isInstance } from "./func";
import { enumerate } from "./iterable";
import { f } from './utils';

export class ExportXlsxWriter {
  fieldNames: string[];
  output: Buffer;
  workbook: any;// ExcelJS.Workbook;
  baseStyle: any;
  headerStyle: any;
  headerBoldStyle: any;
  dateStyle: any;
  datetimeStyle: any;
  worksheet: any;
  value: any;
  floatFormat: string;
  monetaryFormat: number;

  constructor(fieldNames: string[], decimalPlaces?: number[], rowCount = 0) {
    this.fieldNames = fieldNames;
    this.output = Buffer.from([]);
    this.workbook = new ExcelJS.Workbook();//this.output, {'inMemory': true});
    this.baseStyle = this.workbook.addFormat({ 'textWrap': true });
    this.headerStyle = this.workbook.addFormat({ 'bold': true })
    this.headerBoldStyle = this.workbook.addFormat({ 'text_wrap': true, 'bold': true, 'bg_color': '#e9ecef' })
    this.dateStyle = this.workbook.addFormat({ 'text_wrap': true, 'num_format': 'yyyy-mm-dd' })
    this.datetimeStyle = this.workbook.addFormat({ 'text_wrap': true, 'num_format': 'yyyy-mm-dd hh:mm:ss' })
    this.worksheet = this.workbook.addWorksheet()
    this.value = null;
    this.floatFormat = '#,##0.00'
    // const decimalPlaces = [res['decimal_places'] for res in request.env['res.currency'].search_read([], ['decimal_places'])]
    this.monetaryFormat = Math.max(...(decimalPlaces ?? [2]));//`#,##0.${Math.max(...(decimalPlaces ?? [2])) * "0"}`;

    if (rowCount > this.worksheet.xlsRowmax) {
      throw new UserError(f('There are too many rows (%s rows, limit: %s) to export as Excel 2007-2013 (.xlsx) format. Consider splitting the export.', rowCount, this.worksheet.xlsRowmax));
    }
  }

  __enter__() {
    this.writeHeader();
    return this;
  }

  __exit__(errObj) {
    if (errObj) {
      console.warn(errObj.message);
    }
    this.close();
  }

  writeHeader() {
    // Write main header
    let i, fieldname;
    for ([i, fieldname] of enumerate(this.fieldNames)) {
      this.write(0, i, fieldname, this.header_style);
    }
    this.worksheet.setColumn(0, i, 30); // around 220 pixels
  }

  header_style(arg0: number, i: any, fieldname: any, headerStyle: any) {
    throw new Error('Method not implemented.');
  }

  close() {
    this.workbook.close();
    doWithSync(this.output, () => {
      this.value = this.output.valueOf();
    });
  }

  write(row, column, cellValue, style?: any) {
    this.worksheet.write(row, column, cellValue, style);
  }

  writeCell(row, column, cellValue) {
    let cellStyle = this.baseStyle;

    if (isInstance(cellValue, Uint8Array)) {
      try {
        // because xlsx uses raw export, we can get a bytes object
        // here. assume this is base64 and decode to a string, if this
        // fails note that you can't export
        cellValue = toText(cellValue);
      } catch (e) {
        throw new UserError(f("Binary fields can not be exported to Excel unless their content is base64-encoded. That does not seem to be the case for %s.", this.fieldNames)[column]);
      }
    }
    if (typeof cellValue === 'string') {
      if (cellValue.length > this.worksheet.xlsStrmax) {
        cellValue = f("The content of this cell is too long for an XLSX file (more than %s characters). Please use the CSV format for this export.", this.worksheet.xlsStrmax);
      }
      else {
        cellValue = cellValue.replace("\r", " ");
      }
    }
    else if (isInstance(cellValue, Date)) {
      cellStyle = this.datetimeStyle;
    }
    else if (typeof cellValue === 'number') {
      cellStyle.setNumFormat(this.floatFormat);
    }
    this.write(row, column, cellValue, cellStyle);
  }
}

export class GroupExportXlsxWriter extends ExportXlsxWriter {
  fields: any[];

  constructor(fields: any[], decimalPlaces?: number[], rowCount = 0) {
    super(fields.map(f => f['label'].trim()), decimalPlaces, rowCount);
    this.fields = fields;
  }

  writeGroup(row, column, groupName, group, groupDepth = 0) {
    groupName = Array.isArray(groupName) && groupName.length > 1 ? groupName[1] : groupName;
    if (group._groupbyType[groupDepth] != 'boolean') {
      groupName = groupName || "Undefined";
    }
    [row, column] = this._writeGroupHeader(row, column, groupName, group, groupDepth);

    // Recursively write sub-groups
    for (const [childGroupName, childGroup] of group.children.items()) {
      [row, column] = this.writeGroup(row, column, childGroupName, childGroup, groupDepth + 1);
    }

    for (const record of group.data) {
      [row, column] = this._writeRow(row, column, record);
    }
    return [row, column];
  }

  _writeRow(row, column, data) {
    for (const value of data) {
      this.writeCell(row, column, value);
      column += 1;
    }
    return [row + 1, 0];
  }

  _writeGroupHeader(row, column, label, group, groupDepth = 0) {
    const aggregates = group.aggregatedValues;

    label = f('%s%s (%s)', '    '.repeat(groupDepth), label, group.count);
    this.write(row, column, label, this.headerBoldStyle);
    for (const field of this.fields.slice(1)) { // No aggregates allowed in the first column because of the group title
      column += 1;
      let aggregatedValue = aggregates.get(field['name']);
      if (field.get('type') === 'monetary') {
        this.headerBoldStyle.setNumFormat(this.monetaryFormat);
      }
      else if (field.get('type') === 'float') {
        this.headerBoldStyle.setNumFormat(this.floatFormat);
      }
      else {
        aggregatedValue = String(aggregatedValue != null ? aggregatedValue : '');
      }
      this.write(row, column, aggregatedValue, this.headerBoldStyle);
    }
    return [row + 1, 0];
  }
}
