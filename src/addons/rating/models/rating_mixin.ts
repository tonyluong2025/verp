import { _Datetime, api, Fields } from "../../../core";
import { Dict } from "../../../core/helper";
import { _super, AbstractModel, MetaModel } from "../../../core/models"
import { expression } from "../../../core/osv";
import { doWith, f, parseFloat, plaintext2html, range, setOptions, subDate, sum } from "../../../core/tools";
import { RATING_LIMIT_MIN, RATING_LIMIT_OK, RATING_LIMIT_SATISFIED } from "./rating";

@MetaModel.define()
class RatingParentMixin extends AbstractModel {
    static _module = module;
    static _name = 'rating.parent.mixin';
    static _description = "Rating Parent Mixin";
    static _ratingSatisfactionDays = false;  // Number of last days used to compute parent satisfaction. Set to False to include all existing rating.

    static ratingIds = Fields.One2many(
        'rating.rating', 'parentResId', {string: 'Ratings',
        autojoin: true, groups: 'base.group_user',
        domain: self => [['parentResModel', '=', self._name]]});
    static ratingPercentageSatisfaction = Fields.Integer(
        "Rating Satisfaction",
        {compute: "_computeRatingPercentageSatisfaction", computeSudo: true,
        store: false, help: "Percentage of happy ratings"});
    static ratingCount = Fields.Integer({string: '# Ratings', compute: "_computeRatingPercentageSatisfaction", computeSudo: true});

    @api.depends('ratingIds.rating', 'ratingIds.consumed')
    async _computeRatingPercentageSatisfaction() {
        // build domain and fetch data
        let domain = [['parentResModel', '=', this._name], ['parentResId', 'in', this.ids], ['rating', '>=', 1], ['consumed', '=', true]];
        if (this.cls._ratingSatisfactionDays) {
            domain = domain.concat([['updatedAt', '>=', subDate(_Datetime.now(), {days: this.cls._ratingSatisfactionDays})]]);
        }
        const data = await this.env.items('rating.rating').readGroup(domain, ['parentResId', 'rating'], ['parentResId', 'rating'], {lazy: false});

        // get repartition of grades per parent id
        const defaultGrades = {'great': 0, 'okay': 0, 'bad': 0}
        const gradesPerParent = Object.fromEntries(this.ids.map(parentId => [parentId, Object.assign({}, defaultGrades)]));  // map: {parentId: {'great': 0, 'bad': 0, 'ok': 0}}
        for (const item of data) {
            const parentId = item['parentResId'],
            rating = item['rating'];
            if (rating > RATING_LIMIT_OK) {
                gradesPerParent[parentId]['great'] += item['__count'];
            }
            else if (rating > RATING_LIMIT_MIN) {
                gradesPerParent[parentId]['okay'] += item['__count'];
            }
            else {
                gradesPerParent[parentId]['bad'] += item['__count'];
            }
        }

        // compute percentage per parent
        for (const record of this) {
            const repartition = gradesPerParent[record.id] ?? defaultGrades;
            const sumRepartition = sum(Object.values(repartition));
            await record.set('ratingCount', sumRepartition);
            await record.set('ratingPercentageSatisfaction', sumRepartition ? (repartition['great'] * 100 / sumRepartition) : -1);
        }
    }
}

@MetaModel.define()
class RatingMixin extends AbstractModel {
    static _module = module;
    static _name = 'rating.mixin';
    static _description = "Rating Mixin";

    static ratingIds = Fields.One2many('rating.rating', 'resId', {string: 'Rating', groups: 'base.groupUser', domain: self => [['resModel', '=', self._name]], autojoin: true});
    static ratingLastValue = Fields.Float('Rating Last Value', {groups: 'base.groupUser', compute: '_computeRatingLastValue', computeSudo: true, store: true});
    static ratingLastFeedback = Fields.Text('Rating Last Feedback', {groups: 'base.groupUser', related: 'ratingIds.feedback'});
    static ratingLastImage = Fields.Binary('Rating Last Image', {groups: 'base.groupUser', related: 'ratingIds.ratingImage'});
    static ratingCount = Fields.Integer('Rating count', {compute: "_computeRatingStats", computeSudo: true});
    static ratingAvg = Fields.Float("Rating Average", {compute: '_computeRatingStats', computeSudo: true});

    @api.depends('ratingIds.rating', 'ratingIds.consumed')
    async _computeRatingLastValue() {
        for (const record of this) {
            const ratings = await this.env.items('rating.rating').search([['resModel', '=', this._name], ['resId', '=', record.id], ['consumed', '=', true]], {limit: 1});
            await record.set('ratingLastValue', ratings.ok && await ratings.rating || 0);
        }
    }

    /**
     * Compute avg and count in one query, as thoses fields will be used together most of the time.
     * @returns 
     */
    @api.depends('ratingIds.resId', 'ratingIds.rating')
    async _computeRatingStats() {
        const domain = expression.AND([await this._ratingDomain(), [['rating', '>=', RATING_LIMIT_MIN]]]);
        const readGroupRes = await this.env.items('rating.rating').readGroup(domain, ['rating:avg'], ['resId'], {lazy: false});  // force average on rating column
        const mapping = Object.fromEntries(readGroupRes.map(item => 
            [item['resId'], {'ratingCount': item['__count'], 'ratingAvg': item['rating']}]
        ));
        for (const record of this) {
            await record.set('ratingCount', (mapping[record.id] ?? {})['ratingCount'] ?? 0);
            await record.set('ratingAvg', (mapping[record.id] ?? {})['ratingAvg'] ?? 0);
        }
    }

    /**
     * If the rated ressource name is modified, we should update the rating res_name too.
            If the rated ressource parent is changed we should update the parent_res_id too
     * @param values 
     * @returns 
     */
    async write(values) {
        //this.env.noRecompute()
        const result = await _super(RatingMixin, this).write(values);
        for (const record of this) {
            if (record.cls._recName in values) {  // set the res_name of ratings to be recomputed
                const resNameField = this.env.models['rating.rating']._fields['resName'];
                this.env.addToCompute(resNameField, await record.ratingIds);
            }
            if (await record._ratingGetParentFieldName() in values) {
                await (await (await record.ratingIds).sudo()).write({'parentResId': (await record[await record._ratingGetParentFieldName()]).id});
            }
        }
        return result;
    }

    /**
     * When removing a record, its rating should be deleted too.
     * @returns 
     */
    async unlink() {
        const recordIds = this.ids,
        result = await _super(RatingMixin, this).unlink();
        await (await (await this.env.items('rating.rating').sudo()).search([['resModel', '=', this._name], ['resId', 'in', recordIds]])).unlink();
        return result;
    }

    /**
     * Return the parent relation field name. Should return a Many2One
     * @returns 
     */
    async _ratingGetParentFieldName() {
        return null;
    }

    /**
     * Returns a normalized domain on rating.rating to select the records to
            include in count, avg, ... computation of current model.
     * @returns 
     */
    async _ratingDomain() {
        return ['&', '&', ['resModel', '=', this._name], ['resId', 'in', this.ids], ['consumed', '=', true]];
    }

    async ratingGetPartnerId() {
        if ('partnerId' in this._fields && (await this['partnerId']).ok) {
            return this['partnerId'];
        }
        return this.env.items('res.partner');
    }

    async ratingGetRatedPartnerId() {
        if ('userId' in this._fields && (await (await this['userId']).partnerId).ok) {
            return (await this['userId']).partnerId;
        }
        return this.env.items('res.partner');
    }

    /**
     * Return access token linked to existing ratings, or create a new rating
        that will create the asked token. An explicit call to access rights is
        performed as sudo is used afterwards as this method could be used from
        different sources, notably templates.
     * @param partner 
     * @returns 
     */
    async ratingGetAccessToken(partner?: any) {
        await this.checkAccessRights('read');
        await this.checkAccessRule('read');
        if (! partner.ok) {
            partner = await this.ratingGetPartnerId();
        }
        const ratedPartner = await this.ratingGetRatedPartnerId();
        const ratings = await (await (await this['ratingIds']).sudo()).filtered(async (x) => (await x.partnerId).id == partner.id && ! await x.consumed);
        let rating;
        if (! ratings.ok) {
            rating = await (await this.env.items('rating.rating').sudo()).create({
                'partnerId': partner.id,
                'ratedPartnerId': ratedPartner.id,
                'resModelId': await this.env.items('ir.model')._getId(this._name),
                'resId': this.id,
                'isInternal': false,
            });
        }
        else {
            rating = ratings[0];
        }
        return rating.accessToken;
    }

    /**
     * This method send rating request by email, using a template given
        in parameter.

         :param template: a mail.template record used to compute the message body;
         :param lang: optional lang; it can also be specified directly on the template
           itself in the lang field;
         :param subtype_id: optional subtype to use when creating the message; is
           a note by default to avoid spamming followers;
         :param force_send: whether to send the request directly or use the mail
           queue cron (preferred option);
         :param composition_mode: comment (message_post) or mass_mail (template.send_mail);
         :param notif_layout: layout used to encapsulate the content when sending email;
     * @param template 
     * @param opts 
     */
    async ratingSendRequest(template, opts: {lang?: any, subtypeId?: any, forceSend?: any, compositionMode?: any, notifLayout?: any}={}) {
        setOptions(opts, {lang: false, subtypeId: false, forceSend: true, compositionMode: 'comment'});
        if (opts.lang) {
            template = await template.withContext({lang: opts.lang});
        }
        if (opts.subtypeId == false) {
            opts.subtypeId = await this.env.items('ir.model.data')._xmlidToResId('mail.mtNote');
        }
        let self = this;
        if (opts.forceSend) {
            self = await self.withContext({mailNotifyForceSend: true});  // default value is True, should be set to false if not?
        }
        for (const record of self) {
            await record.messagePostWithTemplate(
                template.id,
                {compositionMode: opts.compositionMode,
                emailLayoutXmlid: opts.notifLayout != null ? opts.notifLayout : 'mail.mailNotificationLight',
                subtypeId: opts.subtypeId}
            );
        }
    }

    /**
     * Apply a rating given a token. If the current model inherits from
        mail.thread mixin, a message is posted on its chatter. User going through
        this method should have at least employee rights because of rating
        manipulation (either employee, either sudo-ed in public controllers after
        security check granting access).

        :param float rate : the rating value to apply
        :param string token : access token
        :param string feedback : additional feedback
        :param string subtype_xmlid : xml id of a valid mail.message.subtype

        :returns rating.rating record
     * @param rate 
     * @param token 
     * @param feedback 
     * @param subtype_xmlid 
     */
    async ratingApply(rate, opts: {token?: any, feedback?: any, subtypeXmlid?: any}={}) {
        let rating;
        if (opts.token) {
            rating = await this.env.items('rating.rating').search([['accessToken', '=', opts.token]], {limit: 1});
        } 
        else {
            rating = await this.env.items('rating.rating').search([['resModel', '=', this._name], ['resId', '=', this.ids[0]]], {limit: 1});
        }
        if (rating.ok) {
            await rating.write({'rating': rate, 'feedback': opts.feedback, 'consumed': true});
            if ('messagePost' in this._fields) {
                const feedback = plaintext2html(opts.feedback || '');
                await (this as any).messagePost({
                    body: f("<img src='/rating/static/src/img/rating_%s.png' alt=':%s/5' style='width:18px;height:18px;float:left;margin-right: 5px;'/>%s", rate, rate, feedback),
                    subtypeXmlid: opts.subtypeXmlid || "mail.mtComment",
                    authorId: (await rating.partnerId).ok && (await rating.partnerId).id || null  // None will set the default author in mail_thread.js
                });
            }
            if ('stageId' in this._fields && (await this['stageId']).ok && ('autoValidationKanbanState' in (await this['stageId'])._fields) && await (await this['stageId']).autoValidationKanbanState) {
                if (await rating.rating > 2) {
                    await this.write({'kanbanState': 'done'});
                }
                else {
                    await this.write({'kanbanState': 'blocked'});
                }
            }
        }
        return rating;
    }

    /**
     * get the repatition of rating grade for the given res_ids.
            :param add_stats : flag to add stat to the result
            :type add_stats : boolean
            :param domain : optional extra domain of the rating to include/exclude in repartition
            :return dictionnary
                if not add_stats, the dict is like
                    - key is the rating value (integer)
                    - value is the number of object (res_model, res_id) having the value
                otherwise, key is the value of the information (string) : either stat name (avg, total, ...) or 'repartition'
                containing the same dict if add_stats was False.
     * @param addStats 
     * @param domain 
     */
    async _ratingGetRepartition(addStats=false, domain?: any) {
        let baseDomain = expression.AND([await this._ratingDomain(), [['rating', '>=', 1]]]);
        if (domain) {
            baseDomain = baseDomain.concat(domain);
        }
        const data = await this.env.items('rating.rating').readGroup(baseDomain, ['rating'], ['rating', 'resId']);
        // init dict with all posible rate value, except 0 (no value for the rating)
        const values = Dict.fromKeys([...range(1, 6)], 0);
        values.updateFrom(data.map(d => [d['rating'], d['ratingCount']]));
        // add other stats
        if (addStats) {
            const ratingNumber = sum(values.values());
            const result = {
                'repartition': values,
                'avg': sum(values.keys().map(key => ratingNumber > 0 ? (parseFloat(Number(key) * values[key]) / ratingNumber) : 0)),
                'total': sum(data.map(it => it['ratingCount'])),
            }
            return result;
        }
        return values;
    }

    /**
     * get the repatition of rating grade for the given res_ids.
            :param domain : optional domain of the rating to include/exclude in grades computation
            :return dictionnary where the key is the grade (great, okay, bad), and the value, the number of object (resModel, resId) having the grade
                    the grade are compute as    0-30% : Bad
                                                31-69%: Okay
                                                70-100%: Great
     * @param domain 
     */
    async ratingGetGrades(domain?: any) {
        const data = await this._ratingGetRepartition(false, domain);
        const res = Dict.fromKeys(['great', 'okay', 'bad'], 0);
        for (const key of Object.keys(data)) {
            if (Number(key) >= RATING_LIMIT_SATISFIED) {
                res['great'] += data[key];
            }
            else if (Number(key) >= RATING_LIMIT_OK) {
                res['okay'] += data[key];
            }
            else {
                res['bad'] += data[key];
            }
        }
        return res;
    }

    /**
     * get the statistics of the rating repatition
            :param domain : optional domain of the rating to include/exclude in statistic computation
            :return dictionnary where
                - key is the name of the information (stat name)
                - value is statistic value : 'percent' contains the repartition in percentage, 'avg' is the average rate
                  and 'total' is the number of rating
     * @param domain 
     * @returns 
     */
    async ratingGetStats(domain?: any) {
        const data = await this._ratingGetRepartition(true, domain);
        const result = {
            'avg': data['avg'],
            'total': data['total'],
            'percent': Dict.fromKeys([...range(1, 6)], 0),
        }
        for (const rate of data['repartition']) {
            result['percent'][rate] = data['total'] > 0 ? (data['repartition'][rate] * 100) / data['total'] : 0;
        }
        return result;
    }
}
