export * from './models';
export * from './wizard';

/**
 * Rewrite ICP's to force groups
 * @param cr 
 * @param registry 
 */
export async function postInit(cr) {
  const { Environment } = require('../../api');

  const env = await Environment.new(cr, global.SUPERUSER_ID, {});
  await env.items('ir.config.parameter').init(true);
}