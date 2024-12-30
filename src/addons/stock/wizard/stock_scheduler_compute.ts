import { MetaModel, TransientModel } from "../../../core/models";
import { doWith } from "../../../core/tools";

@MetaModel.define()
class StockSchedulerCompute extends TransientModel {
    static _module = module;
    static _name = 'stock.scheduler.compute';
    static _description = 'Run Scheduler Manually';

    async _procureCalculationOrderpoint() {
        // As this function is in a new thread, I need to open a new cursor, because the old one may be closed
        const newCr = this.pool.cursor();
        let self = this;
        await doWith(newCr, async () => {
            const _self = await self.withEnv(await self.env.change({ cr: newCr }));
            const schedulerCron = await (await _self.sudo()).env.ref('stock.irCronSchedulerAction');
            // Avoid to run the scheduler multiple times in the same time
            try {
                // with tools.mute_logger('verp.sql_db'):
                await _self._cr.execute(`SELECT id FROM "irCron" WHERE id = %s FOR UPDATE NOWAIT`, [schedulerCron.id,]);
            } catch (e) {
                console.info('Attempt to run procurement scheduler aborted, as already running');
                await _self._cr.rollback();
                return {};
            }
            const [companyId, companyIds] = await (await _self.env.user())('companyId', 'companyIds');
            for (const company of companyIds) {
                const cids = companyId.or(companyIds).ids;
                await (await _self.env.items('procurement.group').withContext({ allowedCompanyIds: cids })).runScheduler(_self._cr.dbName, company.id);
            }
            await _self._cr.rollback();
        });
        return {};
    }

    async procureCalculation() {
        console.log('Not Implemented');
        // const threadedCalculation = new Thread(this._procureCalculationOrderpoint);
        // await threadedCalculation.start();
        return { 'type': 'ir.actions.client', 'tag': 'reload' }
    }
}