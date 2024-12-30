import { getattr } from "../../../api";
import { AccessDenied } from "../../../helper";
import { AbstractModel, MetaModel, getmembers } from "../../../models";
import { isCallable } from "../../../tools";

/**
 * Return whether ``func`` is an autovacuum method.
 * @param func 
 * @returns 
 */
export function isAutovacuum(func) {
    return isCallable(func) && getattr(func, '_autovacuum', false);
}

/**
 * Helper model to the ``@api.autovacuum`` method decorator.
 */
@MetaModel.define()
class IrAutoVacuum extends AbstractModel {
    static _module = module;
    static _name = 'ir.autovacuum';
    static _description = 'Automatic Vacuum';

    /**
     * Perform a complete database cleanup by safely calling every
        ``@api.autovacuum`` decorated method.
     */
    async _runVacuumCleaner() {
        if (! await this.env.isAdmin()) {
            throw new AccessDenied();
        }

        for (const model of Object.values(this.env.models)) {
            const cls = model.constructor;
            for (const [attr, func] of getmembers(cls, 'class', isAutovacuum)) {
                console.debug('Calling %s.%s()', model, attr);
                try {
                    await func(model);
                    await this.env.cr.commit();
                    await this.env.cr.reset();
                } catch (e) {
                    console.error("Failed %s.%s()", model, attr);
                    await this.env.cr.rollback();
                }
            }
        }

        // Ensure backward compatibility with the previous autovacuum API
        try {
            // this.powerOn()
            await this.env.cr.commit();
            await this.env.cr.reset();
        } catch (e) {
            console.error("Failed powerOn")
            await this.env.cr.rollback()
        }
    }
}