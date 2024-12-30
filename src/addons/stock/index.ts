export * from './controllers';
export * from './models';
export * from './report';
export * from './wizard';
// export * from './populate';

export async function preInitHook(cr) {
  const { Environment } = require('../../core/api');
  const env = await Environment.new(cr, global.SUPERUSER_ID);
  await (await env.items('ir.model.data').search([
    ['model', 'like', '%stock%'],
    ['module', '=', 'stock']
  ])).unlink();
}

export async function _assignDefaultMailTemplatePickingId(cr) {
  const { Environment } = require('../../core/api');
  const env = await Environment.new(cr, global.SUPERUSER_ID);
  const companyIdsWithoutDefaultMailTemplateId = await env.items('res.company').search([
    ['stockMailConfirmationTemplateId', '=', false]
  ]);
  const defaultMailTemplateId = await env.ref('stock.mailTemplateDataDeliveryConfirmation', false);
  if (defaultMailTemplateId.ok) {
    await companyIdsWithoutDefaultMailTemplateId.write({
      'stockMailConfirmationTemplateId': defaultMailTemplateId.id,
    });
  }
}