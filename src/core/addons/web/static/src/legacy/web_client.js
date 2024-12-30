verp.define("web.webClient", function () {
    return {};
});

verp.define("web.pseudoWebClient", function (require) {
    const FakeWebClient = require("web.webClient");

    function makeLegacyWebClientService(legacyEnv) {
        const legacyPseudoWebClient = {
            dependencies: ["title", "router"],
            start(env) {
                function setTitlePart(part, title = null) {
                    env.services.title.setParts({ [part]: title });
                }
                legacyEnv.bus.on("setTitlePart", null, (params) => {
                    const { part, title } = params;
                    setTitlePart(part, title || null);
                });
                Object.assign(FakeWebClient, {
                    doPushState(state) {
                        if ("title" in state) {
                            setTitlePart("action", state.title);
                            delete state.title;
                        }
                        env.services.router.pushState(state);
                    },
                    setTitle(title) {
                        setTitlePart("action", title);
                    },
                });
            },
        };
        return legacyPseudoWebClient;
    }

    return makeLegacyWebClientService;
});
