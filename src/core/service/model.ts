import { security } from ".";
import * as core from "..";
import { Environment, callKw } from "../api";
import { NameError } from "../helper";
import { checkMethodName, traverseContainers } from "../models";
import { doWith, parseInt } from "../tools";

export const PG_CONCURRENCY_ERRORS_TO_RETRY = [];

export async function dispatch(method, req, ...params) {
    const [db, uid, passwd] = [params[0], parseInt(params[1]), params[2]];

    // set uid tracker - cleaned up at the WSGI
    // dispatching phase in core.service.wsgiServer.application
    req.uid = uid;

    params = params.slice(3);
    if (method === 'objList') {
        throw new NameError("objList has been discontinued via RPC as of 6.0, please query ir.model directly!");
    }
    if (!['execute', 'executeKw'].includes(method)) {
        throw new NameError("Method not available %s", method);
    }
    await security.check(req, db, uid, passwd);
    const registry = await (await core.registry(db)).checkSignaling();
    const fn = module.exports[method];
    let result;
    for await (const reg of registry.manageChanges()) {
        result = await fn(db, uid, ...params);
    }
    return result;
}

class ModelService {
    static check() {
        function wrapper(target, prop, descriptor) {

        }
        return wrapper;
    }

    async executeCr(cr, uid, obj, method, ...args) {
        // clean cache etc if we retry the same transaction
        await cr.reset(true);
        const recs = (await Environment.new(cr, uid)).items(obj);
        const kw = typeof (args[args.length - 1]) === 'object' ? args.pop() : {};
        const result = await callKw(recs, method, args, kw);
        // force evaluation of lazy values before the cursor is closed, as it would
        // error afterwards if the lazy isn't already evaluated (and cached)
        // for (const l of traverseContainers(result, Lazy)) {
        //     const res = l._value;
        // }
        return result;
    }

    async executeKw(db, uid, obj, method, ...args) {
        return this.execute(db, uid, obj, method, ...args);
    }

    @ModelService.check()
    async execute(db, uid, obj, method, ...args) {
        process.env.dbName = db;
        const cr = (await core.registry(db)).cursor();
        let res;
        await doWith(cr, async () => {
            checkMethodName(method);
            res = await this.executeCr(cr, uid, obj, method, ...args);
            if (res == null) {
                console.info('The method %s of the object %s can not return `None` !', method, obj);
            }
        });
        return res;
    }
}