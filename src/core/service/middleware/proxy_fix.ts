export class ProxyFix extends Function {
  private app: Function;

  constructor(app) {
    super();
    this.app =app;

    return new Proxy(this, {
      apply(target, thisArg, args: any[] = []) {
        return target.__call__(args[0], args[1]);
      }
    })
  }
  
  /**
   * Handle a WSGI request
   * @param request 
   * @param response 
   */
  __call__(req, res) {
    return this.app(req, res);
  }
}