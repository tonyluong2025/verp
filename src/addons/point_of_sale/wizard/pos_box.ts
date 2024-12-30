import { UserError } from "../../../core/helper";
import { MetaModel, TransientModel, _super } from "../../../core/models"
import { bool } from "../../../core/tools";
import { CashBox } from "../../account";

@MetaModel.define()
class PosBox extends CashBox {
    static _module = module;
    static _register = false;

    async run() {
        const activeModel = this.env.context['activeModel'] ?? false,
        activeIds = this.env.context['activeIds'] ?? [];

        if (activeModel === 'pos.session') {
            const bankStatements = [];
             
            for (const session of this.env.items(activeModel).browse(activeIds)) {
                const cashRegister = await session.cashRegisterId;
                if (bool(cashRegister)) {
                    bankStatements.push(cashRegister);
                }
            }
            if (! bankStatements.length) {
                throw new UserError(await this._t("There is no cash register for this PoS Session"));
            }
            return this._run(bankStatements);
        }
        else {
            // return _super(PosBox, this).run();
            return super.run();
        }
    }
}

@MetaModel.define()
class PosBoxOut extends PosBox {
    static _module = module;
    static _parents = 'cash.box.out';

    async _calculateValuesForStatementLine(record) {
        const values = await _super(PosBoxOut, this)._calculateValuesForStatementLine(record),
        activeModel = this.env.context['activeModel'] ?? false,
        activeIds = this.env.context['activeIds'] ?? [];
        if (activeModel === 'pos.session' && bool(activeIds)) {
            values['ref'] = await this.env.items(activeModel).browse(activeIds)[0].label;
        }
        return values;
    }
}