import * as uuid from "uuid";
import { Fields, _Datetime, api } from "../../../core";
import { _tzGet } from "../../../core/addons/base";
import { UserError, ValueError } from "../../../core/helper";
import { WebRequest, WebResponse } from "../../../core/http";
import { MetaModel, Model } from "../../../core/models";
import { expression } from "../../../core/osv";
import { allTimezones, bool, parseInt, update } from "../../../core/tools";
import { addDate, diffDate, formatTimeAgo, subDate } from "../../../core/tools/date_utils";

@MetaModel.define()
class WebsiteTrack extends Model {
    static _module = module;
    static _name = 'website.track';
    static _description = 'Visited Pages';
    static _order = 'visitDatetime DESC';
    static _logAccess = false;

    static visitorId = Fields.Many2one('website.visitor', { ondelete: "CASCADE", index: true, required: true, readonly: true });
    static pageId = Fields.Many2one('website.page', { index: true, ondelete: 'CASCADE', readonly: true });
    static url = Fields.Text('Url', { index: true });
    static visitDatetime = Fields.Datetime('Visit Date', { default: () => _Datetime.now(), required: true, readonly: true });
}

@MetaModel.define()
class WebsiteVisitor extends Model {
    static _module = module;
    static _name = 'website.visitor';
    static _description = 'Website Visitor';
    static _order = 'lastConnectionDatetime DESC';

    static label = Fields.Char('Name');
    static accessToken = Fields.Char({ required: true, default: () => uuid.v4(), index: false, copy: false, groups: 'website.groupWebsitePublisher' });
    static active = Fields.Boolean('Active', { default: true });
    static websiteId = Fields.Many2one('website', { string: "Website", readonly: true });
    static partnerId = Fields.Many2one('res.partner', { string: "Contact", help: "Partner of the last logged in user." });
    static partnerImage = Fields.Binary({ related: 'partnerId.image1920' });

    // localisation and info
    static countryId = Fields.Many2one('res.country', { string: 'Country', readonly: true });
    static countryFlag = Fields.Char({ related: "countryId.imageUrl", string: "Country Flag" });
    static langId = Fields.Many2one('res.lang', { string: 'Language', help: "Language from the website when visitor has been created" });
    static timezone = Fields.Selection(_tzGet, { string: 'Timezone' });
    static email = Fields.Char({ string: 'Email', compute: '_computeEmailPhone', computeSudo: true });
    static mobile = Fields.Char({ string: 'Mobile', compute: '_computeEmailPhone', computeSudo: true });

    // Visit fields
    static visitCount = Fields.Integer('# Visits', { default: 1, readonly: true, help: "A new visit is considered if last connection was more than 8 hours ago." });
    static websiteTrackIds = Fields.One2many('website.track', 'visitorId', { string: 'Visited Pages History', readonly: true });
    static visitorPageCount = Fields.Integer('Page Views', { compute: "_computePageStatistics", help: "Total number of visits on tracked pages" });
    static pageIds = Fields.Many2many('website.page', { string: "Visited Pages", compute: "_computePageStatistics", groups: "website.groupWebsiteDesigner", search: "_searchPageIds" });
    static pageCount = Fields.Integer('# Visited Pages', { compute: "_computePageStatistics", help: "Total number of tracked page visited" });
    static lastVisitedPageId = Fields.Many2one('website.page', { string: "Last Visited Page", compute: "_computeLastVisitedPageId" });

    // Time fields
    static createdAt = Fields.Datetime('First Connection', { readonly: true });
    static lastConnectionDatetime = Fields.Datetime('Last Connection', { default: () => _Datetime.now(), help: "Last page view date", readonly: true });
    static timeSinceLastAction = Fields.Char('Last action', { compute: "_computeTimeStatistics", help: 'Time since last page view. E.g.: 2 minutes ago' });
    static isConnected = Fields.Boolean('Is connected ?', { compute: '_computeTimeStatistics', help: 'A visitor is considered as connected if his last page view was within the last 5 minutes.' });

    static _sqlConstraints = [
        ['access_token_unique', 'unique("accessToken")', 'Access token should be unique.'],
        ['partner_uniq', 'unique("partnerId")', 'A partner is linked to only one visitor.'],
    ];

    @api.depends('label')
    async nameGet() {
        const res = [];
        for (const record of this) {
            res.push([
                record.id,
                await record.label || await this._t('Website Visitor #%s', record.id)
            ]);
        }
        return res;
    }

    @api.depends('partnerId.emailNormalized', 'partnerId.mobile', 'partnerId.phone')
    async _computeEmailPhone() {
        const results = await this.env.items('res.partner').searchRead(
            [['id', 'in', (await this['partnerId']).ids]],
            ['id', 'emailNormalized', 'mobile', 'phone'],
        );
        const mappedData = Object.fromEntries(results.map(result => [result['id'], {
            'emailNormalized': result['emailNormalized'],
            'mobile': result['mobile'] ? result['mobile'] : result['phone']
        }]));

        for (const visitor of this) {
            await visitor.set('email', (mappedData[(await visitor.partnerId).id] ?? {})['emailNormalized']);
            await visitor.set('mobile', (mappedData[(await visitor.partnerId).id] ?? {})['mobile']);
        }
    }

    @api.depends('websiteTrackIds')
    async _computePageStatistics() {
        const results = await this.env.items('website.track').readGroup(
            [['visitorId', 'in', this.ids], ['url', '!=', false]], ['visitorId', 'pageId', 'url'], ['visitorId', 'pageId', 'url'], { lazy: false });
        const mappedData = {}
        for (const result of results) {
            const visitorInfo = mappedData[result['visitorId'][0]] ?? { 'pageCount': 0, 'visitorPageCount': 0, 'pageIds': [] };
            visitorInfo['visitorPageCount'] += result['__count'];
            visitorInfo['pageCount'] += 1;
            if (bool(result['pageId'])) {
                visitorInfo['pageIds'].push(result['pageId'][0]);
            }
            mappedData[result['visitorId'][0]] = visitorInfo;
        }

        for (const visitor of this) {
            const visitorInfo = mappedData[visitor.id] ?? { 'pageCount': 0, 'visitorPageCount': 0, 'pageIds': [] };
            await visitor.set('pageIds', [[6, 0, visitorInfo['pageIds']]]);
            await visitor.set('visitorPageCount', visitorInfo['visitorPageCount']);
            await visitor.set('pageCount', visitorInfo['page_count']);
        }
    }

    async _searchPageIds(operator, value) {
        if (!['like', 'ilike', 'not like', 'not ilike', '=like', '=ilike', '=', '!='].includes(operator)) {
            throw new ValueError(await this._t('This operator is not supported'));
        }
        return [['websiteTrackIds.pageId.label', operator, value]];
    }

    @api.depends('websiteTrackIds.pageId')
    async _computeLastVisitedPageId() {
        const results = await this.env.items('website.track').readGroup([['visitorId', 'in', this.ids]],
            ['visitorId', 'pageId', 'visitDatetime:max'],
            ['visitorId', 'pageId'], { lazy: false });
        const mappedData = Object.fromEntries(results.filter(result => bool(result['pageId'])).map(result => [result['visitorId'][0], result['pageId'][0]]));
        for (const visitor of this) {
            await visitor.set('lastVisitedPageId', mappedData[visitor.id] ?? false);
        }
    }

    @api.depends('lastConnectionDatetime')
    async _computeTimeStatistics() {
        for (const visitor of this) {
            await visitor.set('timeSinceLastAction', await formatTimeAgo(this.env, subDate(new Date(), await visitor.lastConnectionDatetime)));
            await visitor.set('isConnected', diffDate(new Date(), await visitor.lastConnectionDatetime, "minutes").minutes < 5);
        }
    }

    /**
     * Purpose of this method is to actualize visitor model prior to contacting
        him. Used notably for inheritance purpose, when dealing with leads that
        could update the visitor model. 
     * @returns 
     */
    async _checkForMessageComposer() {
        const partner = await this['partnerId'];
        return bool(partner.ok && await partner.email);
    }

    async _prepareMessageComposerContext() {
        const partner = await this['partnerId'];
        return {
            'default_model': 'res.partner',
            'default_resId': partner.id,
            'default_partnerIds': [partner.id],
        }
    }

    async actionSendMail() {
        this.ensureOne();
        if (! await this._checkForMessageComposer()) {
            throw new UserError(await this._t("There are no contact and/or no email linked to this visitor."));
        }
        const visitorComposerCtx = await this._prepareMessageComposerContext();
        const composeForm = await this.env.ref('mail.emailComposeMessageWizardForm', false);
        const composeCtx = {
            default_useTemplate: false,
            default_compositionMode: 'comment',
        }
        update(composeCtx, visitorComposerCtx);
        return {
            'label': await this._t('Contact Visitor'),
            'type': 'ir.actions.actwindow',
            'viewMode': 'form',
            'resModel': 'mail.compose.message',
            'views': [[composeForm.id, 'form']],
            'viewId': composeForm.id,
            'target': 'new',
            'context': composeCtx,
        }
    }

    /**
     * Return the visitor as sudo from the request if there is a visitor_uuid cookie.
            It is possible that the partner has changed or has disconnected.
            In that case the cookie is still referencing the old visitor and need to be replaced
            with the one of the visitor returned !!!. 
     * @param forcecreate 
     * @returns 
     */
    async _getVisitorFromRequest(forcecreate: boolean = false) {
        // This function can be called in json with mobile app.
        // In case of mobile app, no uid is set on the jsonRequest env.
        // In case of multi db, _env is None on request, and request.env unbound.
        const req = this.env.req;
        if (!req) {
            return null;
        }
        const visitorSudo = await this.env.items('website.visitor').sudo();
        let visitor = visitorSudo;
        const accessToken = req.httpRequest.cookie['visitor_uuid'];
        if (accessToken) {
            visitor = await (await visitorSudo.withContext({ activeTest: false })).search([['accessToken', '=', accessToken]]);
            // Prefetch accessToken and other Fields. Since accessToken has a restricted group and we access
            // a non restricted field (partnerId) first it is not fetched and will require an additional query to be retrieved.
            await visitor.accessToken;
        }

        const user = await this.env.user();
        if (! await user._isPublic()) {
            const partner = await user.partnerId;
            if (!visitor.ok || (await visitor.partnerId).ok && !(await visitor.partnerId).eq(partner)) {
                // Partner and no cookie or wrong cookie
                visitor = await (await visitorSudo.withContext({ activeTest: false })).search([['partnerId', '=', partner.id]]);
            }
        }
        else if (visitor.ok && (await visitor.partnerId).ok) {
            // Cookie associated to a Partner
            visitor = visitorSudo;
        }

        if (visitor.ok && ! await visitor.timezone) {
            const tz = await this._getVisitorTimezone();
            if (tz) {
                await visitor._updateVisitorTimezone(tz);
            }
        }
        if (!visitor.ok && forcecreate) {
            visitor = await this._createVisitor();
        }

        return visitor;
    }

    async _handleWebpageDispatch(req: WebRequest, res: WebResponse, websitePage) {
        // get visitor. Done here to avoid having to do it multiple times in case of override.
        const visitorSudo = await this._getVisitorFromRequest(true);
        if ((req.httpRequest.cookie['visitor_uuid'] || '') !== await visitorSudo.accessToken) {
            const expirationDate = addDate(new Date(), { days: 365 });
            res.setCookie('visitor_uuid', await visitorSudo.accessToken, { expires: expirationDate });
        }
        await this._handleWebsitePageVisit(req, res, websitePage, visitorSudo);
    }

    /**
     * Called on dispatch. This will create a website.visitor if the http request object
        is a tracked website page or a tracked view. Only on tracked elements to avoid having
        too much operations done on every page or other http requests.
        Note: The side effect is that the lastConnectionDatetime is updated ONLY on tracked elements.
     * @param websitePage 
     * @param visitorSudo 
     */
    async _handleWebsitePageVisit(req, res, websitePage, visitorSudo) {
        const url = req.httpRequest.url;
        const websiteTrackValues = {
            'url': url,
            'visitDatetime': new Date(),
        }
        let domain;
        if (websitePage) {
            websiteTrackValues['pageId'] = websitePage.id;
            domain = [['pageId', '=', websitePage.id]];
        }
        else {
            domain = [['url', '=', url]];
        }
        await visitorSudo._addTracking(domain, websiteTrackValues);
        if ((await visitorSudo.langId).id != req.lang.id) {
            await visitorSudo.write({ 'langId': req.lang.id });
        }
    }

    /**
     * Add the track and update the visitor
     * @param domain 
     * @param websiteTrackValues 
     */
    async _addTracking(domain, websiteTrackValues) {
        domain = expression.AND([domain, [['visitorId', '=', this.id]]]);
        const lastView = await (await this.env.items('website.track').sudo()).search(domain, { limit: 1 });
        if (!lastView.ok || await lastView.visitDatetime < subDate(new Date(), { minutes: 30 })) {
            websiteTrackValues['visitorId'] = this.id;
            await this.env.items('website.track').create(websiteTrackValues);
        }
        await this._updateVisitorLastVisit();
    }

    /**
     * Create a visitor. Tracking is added after the visitor has been created.
     * @returns 
     */
    async _createVisitor() {
        const req: any = this.env.req;
        const countryCode = (req.session['geoip'], {})['countryCode'] ?? false;
        const countryId = bool(countryCode) ? await (await (await req.getEnv()).items('res.country').sudo()).search([['code', '=', countryCode]], { limit: 1 }).id : false;
        const vals = {
            'langId': req.lang.id,
            'countryId': countryId,
            'websiteId': req.website.id,
        }

        const tz = await this._getVisitorTimezone();
        if (tz) {
            vals['timezone'] = tz;
        }
        const user = await this.env.user();
        if (! await user._isPublic()) {
            vals['partnerId'] = (await user.partnerId).id;
            vals['label'] = await (await user.partnerId).label;
        }
        return (await this.sudo()).create(vals);
    }

    /**
     * Link visitors to a partner. This method is meant to be overridden in
        order to propagate, if necessary, partner information to sub records.

        :param partner: partner used to link sub records;
        :param update_values: optional values to update visitors to link;
     * @param partner 
     * @param updateValues 
     */
    async _linkToPartner(partner, updateValues?: any) {
        const vals = { 'label': await partner.label }
        if (bool(updateValues)) {
            update(vals, updateValues);
        }
        await this.write(vals);
    }

    /**
     * Link visitors to target visitors, because they are linked to the
        same identity. Purpose is mainly to propagate partner identity to sub
        records to ease database update and decide what to do with "duplicated".
        THis method is meant to be overridden in order to implement some specific
        behavior linked to sub records of duplicate management.

        :param target: main visitor, target of link process;
        :param keep_unique: if true, find a way to make target unique;
     * @param target 
     * @param keepUnique 
     * @returns 
     */
    async _linkToVisitor(target, keepUnique: boolean = true) {
        // Link sub records of self to target partner
        if (bool(await target.partnerId)) {
            await this._linkToPartner(await target.partnerId);
        }
        // Link sub records of self to target visitor
        await (await this['websiteTrackIds']).write({ 'visitorId': target.id });

        if (keepUnique) {
            await this.unlink();
        }

        return target;
    }

    async _cronArchiveVisitors() {
        const delayDays = parseInt(await (await this.env.items('ir.config.parameter').sudo()).getParam('website.visitor.live.days', 30));
        const deadline = subDate(new Date(), { days: delayDays });
        const visitorsToArchive = await (await this.env.items('website.visitor').sudo()).search([['lastConnectionDatetime', '<', deadline]]);
        await visitorsToArchive.write({ 'active': false });
    }

    /**
     * We need to do this part here to avoid concurrent updates error. 
     * @param timezone 
     */
    async _updateVisitorTimezone(timezone) {
        const query = `
            UPDATE 'websiteVisitor'
            SET timezone = $1
            WHERE id IN (
                SELECT id FROM "websiteVisitor" WHERE id = $2
                FOR NO KEY UPDATE SKIP LOCKED
            )
        `;
        await this.env.cr.execute(query, { bind: [timezone, this.id] });
    }

    /**
     * We need to do this part here to avoid concurrent updates error.
     */
    async _updateVisitorLastVisit() {
        try {
            // with self.env.cr.savepoint():
            const queryLock = `SELECT * FROM "websiteVisitor" where id = %s FOR NO KEY UPDATE NOWAIT`;
            await this.env.cr.execute(queryLock, [this.id,], false);

            const dateNow = new Date();
            let query = `UPDATE "websiteVisitor" SET `
            if (await this['lastConnectionDatetime'] < subDate(dateNow, { hours: 8 })) {
                query += `"visitCount" = "visitCount" + 1,`;
            }
            query += `
                    active = true,
                    "lastConnectionDatetime" = $1
                    WHERE id = $2
                `
            await this.env.cr.execute(query, { bind: [dateNow, this.id] }, false);
        } catch (e) {
            // pass
        }
    }

    async _getVisitorTimezone() {
        const req = this.env.req;
        const user = await this.env.user();
        const tz = req ? req.httpRequest.cookie['tz'] : null;
        if (allTimezones.includes(tz)) {
            return tz;
        }
        else if (! await user._isPublic()) {
            return await user.tz;
        }
        else {
            return null;
        }
    }
}