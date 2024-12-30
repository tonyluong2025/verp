verp.define("web.SessionOverrideForTests", (require) => {
    // Override the Session.sessionReload function
    // The wowl test infrastructure does set a correct verp global value before each test
    // while the session is built only once for all tests.
    // So if a test does a sessionReload, it will merge the verp global of that test
    // into the session, and will alter every subsequent test of the suite.
    // Obviously, we don't want that, ever.
    const { session: sessionInfo } = require("@web/session");
    const initialSessionInfo = Object.assign({}, sessionInfo);
    const Session = require("web.Session");
    const { patch } = require("@web/core/utils/patch");
    patch(Session.prototype, "web.SessionTestPatch", {
        async sessionReload() {
            for (const key in sessionInfo) delete sessionInfo[key];
            for (const key in initialSessionInfo) {
                sessionInfo[key] = initialSessionInfo[key];
            }
            return await this._super(...arguments);
        },
    });
});

verp.define("web.test_legacy", async (require) => {
    require("web.SessionOverrideForTests");

    const legacyProm = new Promise(async (resolve) => {
        const session = require("web.session");
        await session.isBound; // await for templates from server
        require("web.testUtils");
        resolve();
    });

    return { legacyProm };
});
