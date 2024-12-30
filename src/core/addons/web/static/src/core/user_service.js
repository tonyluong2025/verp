/** @verp-module **/

import { registry } from "./registry";
import { session } from "@web/session";

export const userService = {
    dependencies: ["rpc"],
    async: ["hasGroup"],
    start(env, { rpc }) {
        const groupProms = {};

        const context = {
            ...session.userContext,
            uid: session.uid,
        };
        return {
            get context() {
                return Object.assign({}, context);
            },
            removeFromContext(key) {
                delete context[key];
            },
            updateContext(update) {
                Object.assign(context, update);
            },
            hasGroup(group) {
                if (!context.uid) {
                    return Promise.resolve(false);
                }
                if (!groupProms[group]) {
                    groupProms[group] = rpc("/web/dataset/callKw/res.users/hasGroup", {
                        model: "res.users",
                        method: "hasGroup",
                        args: [group],
                        kwargs: { context },
                    });
                }
                return groupProms[group];
            },
            name: session.name,
            userName: session.username,
            isAdmin: session.isAdmin,
            isSystem: session.isSystem,
            partnerId: session.partnerId,
            homeActionId: session.homeActionId,
            showEffect: session.showEffect,
            get userId() {
                return context.uid;
            },
            get lang() {
                return context.lang;
            },
            get tz() {
                return context.tz;
            },
            get db() {
                const res = {
                    name: session.db,
                };
                if ("dbuuid" in session) {
                    res.uuid = session.dbuuid;
                }
                return res;
            },
        };
    },
};

registry.category("services").add("user", userService);
