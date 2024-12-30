// try:
//     from verp.tools.rendering_tools import template_env_globals
//     from verp.addons.http_routing.models.ir_http import slug

//     template_env_globals.update({
//         'slug': slug
//     })
// except ImportError:
//     pass

export * from './controllers'; // not
export * from './models';
export * from './wizard';