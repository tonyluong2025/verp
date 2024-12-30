export * from './controllers';
export * from './models';
export * from './report';
export * from './wizard';

async function postInitHook(cr, registry) {
  console.log(`postInitHook module in ${__filename}`);
}
