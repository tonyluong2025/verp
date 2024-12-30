import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class Tour extends Model {
  static _module = module;
    static _name = "web.tour.tour";
    static _description = "Tours";
    static _logAccess = false;

    static label = Fields.Char({string: "Tour name", required: true});
    static userId = Fields.Many2one('res.users', {string: 'Consumed by'});

    /**
     * Sets given tours as consumed, meaning that
            these tours won't be active anymore for that user 
     * @param tourNames 
     * @returns 
     */
    @api.model()
    async consume(tourNames) {
      if (! await (await this.env.user()).hasGroup('base.groupUser')) {
          // Only internal users can use this method.
          // TODO master: update ir.model.access records instead of using sudo()
          return;
      }
      for (const name of tourNames) {
        await (await this.sudo()).create({'label': name, 'userId': this.env.uid});
      }
    }

    /**
     * Returns the list of consumed tours for the current user
     * @returns 
     */
    @api.model()
    async getConsumedTours() {
      return (await this.search([['userId', '=', this.env.uid]])).mapped('label');
    }
}