import http from 'http';
import { WebRequest } from '../../../core/http';
import { AbstractModel, MetaModel, _super } from '../../../core/models';

@MetaModel.define()
class Http extends AbstractModel {
  static _module = module;
  static _parents = 'ir.http';

  async _dispatch(req: WebRequest, res: http.ServerResponse) {
    // add signup token or login to the session if given
    if ('authSignupToken' in req.params) {
      req.session['authSignupToken'] = req.params['authSignupToken'];
    }
    if ('authLogin' in req.params) {
      req.session['authLogin'] = req.params['authLogin'];
    }

    return _super(Http, this)._dispatch(req, res);
  }
}