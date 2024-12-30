export * from './models';

export async function _assignDefaultNomeclatureId(cr) {
  const { Environment } = require('../../core/api');
  
  const env = await Environment.new(cr, global.SUPERUSER_ID);
  const companyIdsWithoutDefaultNomenclatureId = await env.items('res.company').search([
    ['nomenclatureId', '=', false]
  ])
  const defaultNomenclatureId = await env.ref('barcodes.defaultBarcodeNomenclature', false);
  if (defaultNomenclatureId.ok) {
    await companyIdsWithoutDefaultNomenclatureId.write({
      'nomenclatureId': defaultNomenclatureId.id,
    })
  }
}