import uuid from 'uuid';
import { Environment } from '../../../core/api';
import { AccessError, parseStack, UserError } from "../../../core/helper/errors";
import { httpPost } from '../../../core/http';
import { isInstance, rpartition, toText, update } from '../../../core/tools';
import { stringify } from '../../../core/tools/json';
import { contextmanager } from '../../../core/tools/context';

const DEFAULT_ENDPOINT = 'https://iap.theverp.com';

// We need to mock iap_jsonrpc during tests as we don't want to perform real calls to RPC endpoints
export function iapJsonrpcMocked(args, kwargs) {
    throw new AccessError("Unavailable during tests.")
}

/*
iap_patch = patch('verp.addons.iap.tools.iap_tools.iap_jsonrpc', iapJsonrpcMocked)

def setUp() {
    old_setup_func(self)
    iap_patch.start()
    self.addCleanup(iap_patch.stop)


old_setup_func = BaseCase.setUp
BaseCase.setUp = setUp
*/

// Tools globals

export const _MAIL_DOMAIN_BLACKLIST = new Set([
    // Top 100 email providers on SaaS at 2020-10
    'gmail.com', 'hotmail.com', 'yahoo.com', 'qq.com', 'outlook.com', '163.com', 'yahoo.fr', 'live.com', 'hotmail.fr', 'icloud.com', '126.com',
    'me.com', 'free.fr', 'ymail.com', 'msn.com', 'mail.com', 'orange.fr', 'aol.com', 'wanadoo.fr', 'live.fr', 'mail.ru', 'yahoo.co.in',
    'rediffmail.com', 'hku.hk', 'googlemail.com', 'gmx.de', 'sina.com', 'skynet.be', 'laposte.net', 'yahoo.co.uk', 'yahoo.co.id', 'web.de',
    'gmail.com ', 'outlook.fr', 'telenet.be', 'yahoo.es', 'naver.com', 'hotmail.co.uk', 'gmai.com', 'foxmail.com', 'hku.hku', 'bluewin.ch',
    'sfr.fr', 'libero.it', 'mac.com', 'rocketmail.com', 'protonmail.com', 'gmx.com', 'gamil.com', 'hotmail.es', 'gmx.net', 'comcast.net',
    'yahoo.com.mx', 'linkedin.com', 'yahoo.com.br', 'yahoo.in', 'yahoo.ca', 't-online.de', '139.com', 'yandex.ru', 'yahoo.com.hk','yahoo.de',
    'yeah.net', 'yandex.com', 'nwytg.net', 'neuf.fr', 'yahoo.com.ar', 'outlook.es', 'abv.bg', 'aliyun.com', 'yahoo.com.tw', 'ukr.net', 'live.nl',
    'wp.pl', 'hotmail.it', 'live.com.mx', 'zoho.com', 'live.co.uk', 'sohu.com', 'twoomail.com', 'yahoo.com.sg', 'theverp.com', 'yahoo.com.vn',
    'windowslive.com', 'gmail', 'vols.utk.edu', 'email.com', 'tiscali.it', 'yahoo.it', 'gmx.ch', 'trbvm.com', 'nwytg.com', 'mvrht.com', 'nyit.edu',
    'o2.pl', 'live.cn', 'gmial.com', 'seznam.cz', 'live.be', 'videotron.ca', 'gmil.com', 'live.ca', 'hotmail.de', 'sbcglobal.net', 'connect.hku.hk',
    'yahoo.com.au', 'att.net', 'live.in', 'btinternet.com', 'gmx.fr', 'voila.fr', 'shaw.ca', 'prodigy.net.mx', 'vip.qq.com', 'yahoo.com.ph',
    'bigpond.com', '7thcomputing.com', 'freenet.de', 'alice.it', 'esi.dz',
    'bk.ru', 'mail.theverp.com', 'gmail.con', 'fiu.edu', 'gmal.com', 'useemlikefun.com', 'google.com', 'trbvn.com', 'yopmail.com', 'ya.ru',
    'hotmail.co.th', 'arcor.de', 'hotmail.ca', '21cn.com', 'live.de', 'outlook.de', 'gmailcom', 'unal.edu.co', 'tom.com', 'yahoo.gr',
    'gmx.at', 'inbox.lv', 'ziggo.nl', 'xs4all.nl', 'sapo.pt', 'live.com.au', 'nate.com', 'online.de', 'sina.cn', 'gmail.co', 'rogers.com',
    'mailinator.com', 'cox.net', 'hotmail.be', 'verizon.net', 'yahoo.co.jp', 'usa.com', 'consultant.com', 'hotmai.com', '189.cn',
    'sky.com', 'eezee-it.com', 'opayq.com', 'maildrop.cc', 'home.nl', 'virgilio.it', 'outlook.be', 'hanmail.net', 'uol.com.br', 'hec.ca',
    'terra.com.br', 'inbox.ru', 'tin.it', 'list.ru', 'hotmail.com ', 'safecoms.com', 'smile.fr', 'sprintit.fi', 'uniminuto.edu.co',
    'bol.com.br', 'bellsouth.net', 'nirmauni.ac.in', 'ldc.edu.in', 'ig.com.br', 'engineer.com', 'scarlet.be', 'inbox.com', 'gmaill.com',
    'freemail.hu', 'live.it', 'blackwaretech.com', 'byom.de', 'dispostable.com', 'dayrep.com', 'aim.com', 'prixgen.com', 'gmail.om',
    'asterisk-tech.mn', 'in.com', 'aliceadsl.fr', 'lycos.com', 'topnet.tn', 'teleworm.us', 'kedgebs.com', 'supinfo.com', 'posteo.de',
    'yahoo.com ', 'op.pl', 'gmail.fr', 'grr.la', 'oci.fr', 'aselcis.com', 'optusnet.com.au', 'mailcatch.com', 'rambler.ru', 'protonmail.ch',
    'prisme.ch', 'bbox.fr', 'orbitalu.com', 'netcourrier.com', 'iinet.net.au',
    // Dummy entries
    'example.com',
])

// List of country codes for which we should offer state filtering when mining new leads.
// See crm.iap.lead.mining.request#_computeAvailableStateIds() or task-2471703 for more details.
export const _STATES_FILTER_COUNTRIES_WHITELIST = new Set([
    'AR', 'AU', 'BR', 'CA', 'IN', 'MY', 'MX', 'NZ', 'AE', 'US'
]);

// Helpers for both clients and proxy

export async function iapGetEndpoint(env: Environment) {
    return (await env.items('ir.config.parameter').sudo()).getParam('iap.endpoint', DEFAULT_ENDPOINT);
}

// Helpers for clients

export class InsufficientCreditError extends UserError {}

export class ConnectionError extends UserError{}

/**
 * Calls the provided JSON-RPC endpoint, unwraps the result and
    returns JSON-RPC errors as exceptions.
 * @param url 
 * @param method 
 * @param params 
 * @param timeout 
 * @returns 
 */
export async function iapJsonrpc(env: Environment, url: string, opts: {method?: string, params?: any, timeout?: number}={}) {
    update(opts, {method: 'call', params: {}, timeout: 15});
    const payload = {
        'jsonrpc': '2.0',
        'method': opts.method,
        'params': opts.params,
        'id': uuid.v4(),
    }

    console.info('iap jsonrpc %s', url);
    try {
        const res = await httpPost(payload, url, opts);
        res.raiseForStatus();
        const response = res.body;
        if ('error' in response) {
            const name = rpartition(response['error']['data']['name'], '.').slice(-1)[0];
            const message = response['error']['data']['message'];
            let eClass;
            if (name === 'verp.addons.iap.tools.iap_tools.InsufficientCreditError') {
                eClass = InsufficientCreditError;
            }
            else if (name === 'AccessError') {
                eClass = AccessError;
            }
            else if (name === 'UserError') {
                eClass = UserError;
            }
            else {
                throw new ConnectionError();
            }
            const e = new eClass(message);
            e.data = response['error']['data'];
            throw e;
        }
        return response['result'];
    } catch(e) {
    // except (ValueError, requests.exceptions.ConnectionError, requests.exceptions.MissingSchema, requests.exceptions.Timeout, requests.exceptions.HTTPError) as e:
        throw new AccessError(
            await this._t('The url that this service requested returned an error. Please contact the author of the app. The url it tried to contact was %s', url)
        );
    }
}

// Helpers for proxy

class IapTransaction {
    credit;

    constructor() {
        this.credit = null;
    }
}

export async function iapAuthorize(env, key, accountToken, credit, dbuuid=false, description?: string, creditTemplate?: any, ttl=4320) {
    const endpoint = await iapGetEndpoint(env);
    const params = {
        'accountToken': accountToken,
        'credit': credit,
        'key': key,
        'description': description,
        'ttl': ttl,
    }
    if (dbuuid) {
        update(params, {'dbuuid': dbuuid});
    }
    let transactionToken;
    try {
        transactionToken = await iapJsonrpc(env, endpoint + '/iap/1/authorize', {method: 'call', params: params});
    } catch(e) {
        if (isInstance(e, InsufficientCreditError)) {
            if (creditTemplate) {
                const args = parseStack(e.stack);
                args.unshift(toText(await env.items('ir.qweb')._render(creditTemplate)));
                e.stack = args.join('\n');
            }
        }
        throw e;
    }
    return transactionToken;
}

export async function iapCancel(env, transactionToken, key) {
    const endpoint = await iapGetEndpoint(env);
    const params = {
        'token': transactionToken,
        'key': key,
    }
    return iapJsonrpc(env, endpoint + '/iap/1/cancel', {method: 'call', params: params});
}

export async function iapCapture(env, transactionToken, key, credit) {
    const endpoint = await iapGetEndpoint(env);
    const params = {
        'token': transactionToken,
        'key': key,
        'creditToCapture': credit,
    }
    return iapJsonrpc(env, endpoint + '/iap/1/capture', {method: 'call', params: params});
}

/**
 * Account charge context manager: takes a hold for ``credit``
    amount before executing the body, then captures it if there
    is no error, or cancels it if the body generates an exception.

    :param str key: service identifier
    :param str account_token: user identifier
    :param int credit: cost of the body's operation
    :param description: a description of the purpose of the charge,
                        the user will be able to see it in their
                        dashboard
    :type description: str
    :param credit_template: a QWeb template to render and show to the
                            user if their account does not have enough
                            credits for the requested operation
    :param int ttl: transaction time to live in hours.
                    If the credit are not captured when the transaction
                    expires, the transaction is canceled
    :type credit_template: str
 * @param env 
 * @param key 
 * @param accountToken 
 * @param credit 
 * @param dbuuid 
 * @param description 
 * @param creditTemplate 
 * @param ttl 
 */
// @contextmanager()
export async function* iapCharge(env, key, accountToken, credit, dbuuid=false, description: any, creditTemplate: any, ttl=4320) {
    const transactionToken = await iapAuthorize(env, key, accountToken, credit, dbuuid, description, creditTemplate, ttl);
    let transaction;
    try {
        transaction = new IapTransaction();
        transaction.credit = credit;
        yield transaction;
    } catch(e) {
        await iapCancel(env, transactionToken, key);
        throw e;
    }
    await iapCapture(env, transactionToken, key, transaction.credit);
}