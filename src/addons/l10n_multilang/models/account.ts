import { Fields } from "../../../core/fields"
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class AccountAccountTag extends Model {
    static _module = module;
    static _parents = 'account.account.tag';

    static label = Fields.Char({translate: true});
}

@MetaModel.define()
class AccountAccountTemplate extends Model {
    static _module = module;
    static _parents = 'account.account.template';

    static label = Fields.Char({translate: true});
}

@MetaModel.define()
class AccountAccount extends Model {
    static _module = module;
    static _parents = 'account.account';

    static label = Fields.Char({translate: true});
}

@MetaModel.define()
class AccountGroupTemplate extends Model {
    static _module = module;
    static _parents = 'account.group.template';

    static label = Fields.Char({translate: true});
}

@MetaModel.define()
class AccountGroup extends Model {
    static _module = module;
    static _parents = 'account.group';

    static label = Fields.Char({translate: true});
}

@MetaModel.define()
class AccountTax extends Model {
    static _module = module;
    static _parents = 'account.tax';

    static label = Fields.Char({translate: true});
    static description = Fields.Char({translate: true});
}

@MetaModel.define()
class AccountTaxTemplate extends Model {
    static _module = module;
    static _parents = 'account.tax.template';

    static label = Fields.Char({translate: true});
    static description = Fields.Char({translate: true});
}

@MetaModel.define()
class AccountChartTemplate extends Model {
    static _module = module;
    static _parents = 'account.chart.template';
    static _order = 'label';

    static label = Fields.Char({translate: true});
    static spokenLanguages = Fields.Char({string: 'Spoken Languages', help: "State here the languages for which the translations of templates could be loaded at the time of installation of this localization module and copied in the final object when generating them from templates. You must provide the language codes separated by ';'"});
}

@MetaModel.define()
class AccountFiscalPosition extends Model {
    static _module = module;
    static _parents = 'account.fiscal.position';

    static label = Fields.Char({translate: true});
    static note = Fields.Html({translate: true});
}

@MetaModel.define()
class AccountFiscalPositionTemplate extends Model {
    static _module = module;
    static _parents = 'account.fiscal.position.template';

    static label = Fields.Char({translate: true});
    static note = Fields.Text({translate: true});
}

@MetaModel.define()
class AccountJournal extends Model {
    static _module = module;
    static _parents = 'account.journal';

    static label = Fields.Char({translate: true});
}

@MetaModel.define()
class AccountAnalyticAccount extends Model {
    static _module = module;
    static _parents = 'account.analytic.account';

    static label = Fields.Char({translate: true});
}

@MetaModel.define()
class AccountTaxReportLine extends Model {
    static _module = module;
    static _parents = 'account.tax.report.line';

    static label = Fields.Char({translate: true});
    static tagLabel = Fields.Char({translate: true});
}

@MetaModel.define()
class ResCountryState extends Model {
    static _module = module;
    static _parents = 'res.country.state';

    static label = Fields.Char({translate: true});
}