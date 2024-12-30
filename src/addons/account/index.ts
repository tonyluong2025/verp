import { bool } from '../../core/tools/bool';

export * from './controllers';
export * from './models';
export * from './demo';
export * from './wizard';
export * from './report';
// export * from './populate';

const SYSCOHADA_LIST = ['BJ', 'BF', 'CM', 'CF', 'KM', 'CG', 'CI', 'GA', 'GN', 'GW', 'GQ', 'ML', 'NE', 'CD', 'SN', 'TD', 'TG'];

/**
 * Sets the fiscal country on existing companies when installing the module.
    That field is an editable computed field. It doesn't automatically get computedon existing records by the ORM when installing the module, so doing that by hand ensures existing records will get a value for it if needed.
 * @param env 
 */
async function _setFiscalCountry(env) {
  await (await env.items('res.company').search([]))._computeAccountTaxFiscalCountry();
}

async function _autoInstallL10n(env) {
  //check the country of the main company (only) and eventually load some module needed in that country
  const countryCode = await (await (await env.company()).countryId).code;
  if (countryCode) {
    //auto install localization module(s) if available
    const toInstallL10n = await env.items('ir.module.module').searchCount([
      ['categoryId', '=', (await env.ref('base.category_accountingLocalizationsAccountCharts')).id],
      ['state', '=', 'to install'],
    ]);
    const moduleList = [];
    if (bool(toInstallL10n)) {
      // We don't install a CoA if one was passed in the command line
      // or has been selected to install
      // pass
    }
    else if (SYSCOHADA_LIST.includes(countryCode)) {
      //countries using OHADA Chart of Accounts
      moduleList.push('l10n_syscohada');
    }
    else if (countryCode === 'GB') {
      moduleList.push('l10n_uk');
    }
    else if (countryCode === 'DE') {
      moduleList.push('l10n_de_skr03')
      moduleList.push('l10n_de_skr04')
    }
    else {
      if (bool(await env.items('ir.module.module').search([['label', '=', 'l10n_' + countryCode.toLowerCase()]]))) {
        moduleList.push('l10n_' + countryCode.toLowerCase());
      }
      else {
        moduleList.push('l10n_generic_coa');
      }
    }
    if (['US', 'CA'].includes(countryCode)) {
      moduleList.push('account_check_printing');
    }
    if (SYSCOHADA_LIST.concat([
      'AT', 'BE', 'CA', 'CO', 'DE', 'EC', 'ES', 'ET', 'FR', 'GR', 'IT', 'LU', 'MX', 'NL', 'NO',
      'PL', 'PT', 'RO', 'SI', 'TR', 'GB', 'VE', 'VN'
    ]).includes(countryCode)) {
      moduleList.push('base_vat');
    }
    if (countryCode === 'MX') {
      moduleList.push('l10n_mx_edi');
    }
    if (countryCode === 'IT') {
      moduleList.push('l10n_it_edi_sdicoop');
    }
    const moduleIds = await env.items('ir.module.module').search([['label', 'in', moduleList], ['state', '=', 'uninstalled']]);
    await (await moduleIds.sudo()).buttonInstall();
  }
}

export async function _accountPostInit(cr) {
  const { Environment } = require('../../core/api');

  const env = await Environment.new(cr, global.SUPERUSER_ID);
  await _autoInstallL10n(env);
  await _setFiscalCountry(env);
}