import uuid from 'uuid';
import { Fields, api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models"
import { update } from '../../../core/tools/misc';
import { f } from '../../../core/tools/utils';
import { urlEncode } from '../../../core/service/middleware/utils';
import { iapGetEndpoint, iapJsonrpc } from '../tools/iap_tools';

const DEFAULT_ENDPOINT = 'https://iap.theverp.com'

@MetaModel.define()
class IapAccount extends Model {
    static _module = module;
    static _name = 'iap.account';
    static _recName = 'serviceName';
    static _description = 'IAP Account';

    static serviceName = Fields.Char();
    static accountToken = Fields.Char({default: (s) => uuid.v4()});
    static companyIds = Fields.Many2many('res.company');

    @api.model()
    async create(vals) {
        const account = await _super(IapAccount, this).create(vals);
        const accountToken = await account.accountToken;
        if (await (await this.env.items('ir.config.parameter').sudo()).getParam('database.isNeutralized') && accountToken) {
            // Disable new accounts on a neutralized database
            await account.set('accountToken', `${accountToken.split('+')[0]}+disabled`);
        }
        return account;
    }

    @api.model()
    async get(serviceName: string, forcecreate: boolean=true) {
        const domain = [
            ['serviceName', '=', serviceName],
            '|',
                ['companyIds', 'in', (await this.env.companies()).ids],
                ['companyIds', '=', false]
        ];
        let accounts = await this.search(domain, {order: 'id desc'});
        const accountsWithoutToken = await accounts.filtered(async (acc) => ! await acc.accountToken);
        if (accountsWithoutToken.ok) {
            const cr = this.pool.cursor();
            // with self.pool.cursor() as cr: 
            {
                // In case of a further error that will rollback the database, we should
                // use a different SQL cursor to avoid undo the accounts deletion.

                // Flush the pending operations to avoid a deadlock.
                await this.flush();
                const iapAccount = await this.withEnv(await this.env.change({cr: cr}));
                // Need to use sudo because regular users do not have delete right
                await (await (await iapAccount.search(domain.concat([['accountToken', '=', false]]))).sudo()).unlink();
                accounts = accounts.sub(accountsWithoutToken);
            }
        }
        if (! accounts.ok) {
            let accountToken, account, iapAccount;
            const cr = this.pool.cursor();
            // with self.pool.cursor() as cr:
            {
                // Since the account did not exist yet, we will encounter a NoCreditError,
                // which is going to rollback the database and undo the account creation,
                // preventing the process to continue any further.

                // Flush the pending operations to avoid a deadlock.
                await this.flush();
                const iapAccount = await this.withEnv(await this.env.change({cr: cr}));
                account = await iapAccount.search(domain, {order: 'id desc', limit: 1});
                if (! account.ok) {
                    if (! forcecreate) {
                        return account;
                    }
                    account = await iapAccount.create({'serviceName': serviceName});
                }
                // fetch 'accountToken' into cache with this cursor,
                // as self's cursor cannot see this account
                accountToken = await account.accountToken;
            }
            account = this.browse(account.id);
            this.env.cache.set(account, iapAccount._fields['accountToken'], accountToken);
            return account;
        }
        const accountsWithCompany = await accounts.filtered(async (acc) => acc.companyIds);
        if (accountsWithCompany.ok) {
            return accountsWithCompany[0];
        }
        return accounts[0];
    }

    /**
     * Called notably by ajax crash manager, buy more widget, partner_autocomplete, sanilmail.
     * @param serviceName 
     * @param baseUrl 
     * @param credit 
     * @param trial 
     * @returns 
     */
    @api.model()
    async getCreditsUrl(serviceName, baseUrl: string='', credit: number=0, trial: boolean=false) {
        const dbuuid = await (await this.env.items('ir.config.parameter').sudo()).getParam('database.uuid');
        if (! baseUrl) {
            const endpoint = await iapGetEndpoint(this.env);
            const route = '/iap/1/credit';
            baseUrl = endpoint + route;
        }
        const accountToken = await (await this.get(serviceName)).accountToken;
        const dist = {
            'dbuuid': dbuuid,
            'serviceName': serviceName,
            'accountToken': accountToken,
            'credit': credit,
        }
        if (trial) {
            update(dist, {'trial': trial});
        }
        return f('%s?%s', baseUrl, urlEncode(dist));
    }

    /**
     * Called only by res settings
     * @returns 
     */
    @api.model()
    async getAccountUrl() {
        const route = '/iap/services';
        const endpoint = await iapGetEndpoint(this.env);
        const dict = {'dbuuid': await (await this.env.items('ir.config.parameter').sudo()).getParam('database.uuid')}

        return f('%s?%s', endpoint + route, urlEncode(dict));
    }

    /**
     * Called notably by ajax partner_autocomplete.
     * @returns 
     */
    @api.model()
    async getConfigAccountUrl() {
        const [account, action, menu, noOne] = [
            await this.env.items('iap.account').get('partner_autocomplete'),
            await this.env.ref('iap.iapAccountAction'),
            await this.env.ref('iap.iapAccountMenu'),
            await this.userHasGroups('base.groupNoOne')
        ];
        let url;
        if (account.ok) {
            url = f("/web#id=%s&action=%s&model=iap.account&viewType=form&menuId=%s", account.id, action.id, menu.id);
        }
        else {
            url = f("/web#action=%s&model=iap.account&viewType=form&menuId=%s", action.id, menu.id);
        }
        return noOne && url;
    }

    @api.model()
    async getCredits(serviceName: string) {
        const account = await this.get(serviceName, false);
        let credit = 0;

        if (account.ok) {
            const route = '/iap/1/balance';
            const endpoint = await iapGetEndpoint(this.env);
            const url = endpoint + route;
            const params = {
                'dbuuid': await (await this.env.items('ir.config.parameter').sudo()).getParam('database.uuid'),
                'accountToken': await account.accountToken,
                'serviceName': serviceName,
            }
            try {
                credit = await iapJsonrpc(this.env, url, {method: 'call', params: params});
            } catch(e) {
            // except Exception as e:
                console.info('Get credit error : %s', e);
                credit = -1;
            }
        }
        return credit;
    }
}