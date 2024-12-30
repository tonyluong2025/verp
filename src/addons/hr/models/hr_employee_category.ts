import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"
import { randrange } from "../../../core/tools";

@MetaModel.define()
class EmployeeCategory extends Model {
    static _module = module;
    static _name = "hr.employee.category";
    static _description = "Employee Category";

    _getDefaultColor() {
        return randrange(1, 11);
    }

    static label = Fields.Char({string: "Tag Name", required: true});
    static color = Fields.Integer({string: 'Color Index', default: self => self._getDefaultColor()});
    static employeeIds = Fields.Many2many('hr.employee', {relation: 'employeeCategoryRel', column1: 'categoryId', column2: 'empId', string: 'Employees'});

    static _sqlConstraints = [
        ['label_uniq', 'unique (label)', "Tag label already exists !"],
    ];
}
