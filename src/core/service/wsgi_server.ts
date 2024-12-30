import { tools } from "..";
import { root } from "../http";
import { NotFound, ProxyFix } from "./middleware";

async function applicationUnproxied(req: any, res: any) {
  const result = root(req, res);
  if (result != null) {
    return result;
  }
  return (new NotFound(res, 'No handler found.\n'))(req, res);
}

export function application(req, res) {
  if (tools.config.options['proxyMode'] && req.hasHeader('X-Forwarded-Host')) {
    return (new ProxyFix(applicationUnproxied))(req, res);
  }
  else {
    return applicationUnproxied(req, res)
  }
}