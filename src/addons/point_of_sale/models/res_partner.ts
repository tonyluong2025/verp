import { Fields, api } from "../../../core";
import { UserError } from "../../../core/helper";
import { MetaModel, Model } from "../../../core/models"
import { bool, pop } from "../../../core/tools";

@MetaModel.define()
class ResPartner extends Model {
    static _module = module;
    static _parents = 'res.partner';

    static posOrderCount = Fields.Integer({
        compute: '_computePosOrder',
        help: "The number of point of sales orders related to this customer",
        groups: "point_of_sale.groupPosUser",
    });
    static posOrderIds = Fields.One2many('pos.order', 'partnerId', {readonly: true});

    async _computePosOrder() {
        // retrieve all children partners and prefetch 'parentId' on them
        const allPartners = await (await this.withContext({activeTest: false})).search([['id', 'childOf', this.ids]]);
        await allPartners.read(['parentId']);

        const posOrderData = await this.env.items('pos.order').readGroup(
            [['partnerId', 'in', allPartners.ids]],
            ['partnerId'], ['partnerId']
        );

        await this.set('posOrderCount', 0);
        for (const group of posOrderData) {
            let partner = this.browse(group['partnerId'][0]);
            while (bool(partner)) {
                if (this.has(partner)) {
                    await partner.set('posOrderCount', await partner.posOrderCount + group['partnerId_count']);
                }
                partner = await partner.parentId;
            }
        }
    }

    /**
     * This function returns an action that displays the pos orders from partner.
     * @returns 
     */
    async actionViewPosOrder() {
        const action = await this.env.items('ir.actions.actions')._forXmlid('point_of_sale.actionPosPosForm');
        if (await this['isCompany']) {
            action['domain'] = [['partnerId.commercialPartnerId.id', '=', this.id]];
        }
        else {
            action['domain'] = [['partnerId.id', '=', this.id]];
        }
        return action;
    }

    /**
     * create or modify a partner from the point of sale ui. partner contains the partner's fields.
     * @param partner 
     */
    @api.model()
    async createFromUi(partner) {
        // image is a dataurl, get the data after the comma
        if (partner['image1920']) {
            partner['image1920'] = partner['image1920'].split(',')[1];
        }
        let partnerId = pop(partner, 'id', false);
        if (partnerId) {  // Modifying existing partner
            await this.browse(partnerId).write(partner);
        }
        else {
            partnerId = (await this.create(partner)).id;
        }
        return partnerId;
    }

    @api.ondelete(false)
    async _unlinkExceptActivePosSession() {
        const runningSessions = await (await this.env.items('pos.session').sudo()).search([['state', '!=', 'closed']]);
        if (bool(runningSessions)) {
            throw new UserError(
                await this._t("You cannot delete contacts while there are active PoS sessions. Close the session(s) %s first.", (await runningSessions.map(session => session.label)).join(', '))
            );
        }
    }
}