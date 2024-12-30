/** @verp-module **/

import { notificationService } from "@web/core/notifications/notification_service";
import { registry } from "@web/core/registry";
import { effectService } from "@web/core/effects/effect_service";
import { RainbowMan } from "@web/core/effects/rainbow_man";
import { userService } from "@web/core/user_service";
import { session } from "@web/session";
import { makeTestEnv } from "../../helpers/mock_env";
import { makeFakeLocalizationService } from "../../helpers/mock_services";
import { click, getFixture, nextTick, patchWithCleanup } from "../../helpers/utils";
import { registerCleanup } from "../../helpers/cleanup";

const { Component, mount, tags } = owl;
const serviceRegistry = registry.category("services");
const mainComponentRegistry = registry.category("mainComponents");

class Parent extends Component {
    setup() {
        this.EffectContainer = mainComponentRegistry.get("EffectContainer");
        this.NotificationContainer = mainComponentRegistry.get("NotificationContainer");
    }
}
Parent.template = tags.xml`
    <div>
      <t t-component="EffectContainer.Component" t-props="EffectContainer.props" />
      <t t-component="NotificationContainer.Component" t-props="NotificationContainer.props" />
    </div>
  `;

async function makeParent() {
    const env = await makeTestEnv({ serviceRegistry });
    const target = getFixture();
    const parent = await mount(Parent, { env, target });
    registerCleanup(() => parent.destroy());
    return parent;
}

QUnit.module("Effect Service", (hooks) => {
    let effectParams;
    hooks.beforeEach(() => {
        effectParams = {
            message: "<div>Congrats!</div>",
            messageIsHtml: true,
            fadeout: "nextTick",
        };

        patchWithCleanup(session, { showEffect: true }); // enable effects

        serviceRegistry.add("user", userService);
        serviceRegistry.add("effect", effectService);
        serviceRegistry.add("notification", notificationService);
        serviceRegistry.add("localization", makeFakeLocalizationService());
    });

    QUnit.test("effect service displays a rainbowman by default", async function (assert) {
        const parent = await makeParent();

        parent.env.services.effect.add({ message: "Hello", fadeout: "no" });
        await nextTick();

        assert.containsOnce(parent.el, ".o-reward");
        assert.strictEqual(parent.el.querySelector(".o-reward").innerText, "Hello");
    });

    QUnit.test("rainbowman effect with showEffect: false", async function (assert) {
        patchWithCleanup(session, { showEffect: false });

        const parent = await makeParent();

        parent.env.services.effect.add({ type: "rainbowMan", message: "", fadeout: "no" });
        await nextTick();

        assert.containsNone(parent.el, ".o-reward");
        assert.containsOnce(parent.el, ".o-notification");
    });

    QUnit.test("rendering a rainbowman destroy after animation", async function (assert) {
        patchWithCleanup(RainbowMan, {
            rainbowFadeouts: { nextTick: 0 },
        });

        const parent = await makeParent();
        parent.env.services.effect.add(effectParams);
        await nextTick();

        assert.containsOnce(parent, ".o-reward");
        assert.containsOnce(parent, ".o-reward-rainbow");
        assert.strictEqual(
            parent.el.querySelector(".o-reward-msg-content").innerHTML,
            "<div>Congrats!</div>"
        );

        const ev = new AnimationEvent("animationend", { animationName: "reward-fading-reverse" });
        parent.el.querySelector(".o-reward").dispatchEvent(ev);
        await nextTick();
        assert.containsNone(parent, ".o-reward");
    });

    QUnit.test("rendering a rainbowman destroy on click", async function (assert) {
        const parent = await makeParent();

        parent.env.services.effect.add({ ...effectParams, fadeout: "no" });
        await nextTick();

        assert.containsOnce(parent.el, ".o-reward");
        assert.containsOnce(parent.el, ".o-reward-rainbow");

        await click(parent.el);
        assert.containsNone(parent, ".o-reward");
    });

    QUnit.test("rendering a rainbowman with an escaped message", async function (assert) {
        const parent = await makeParent();

        parent.env.services.effect.add({ ...effectParams, messageIsHtml: false });
        await nextTick();

        assert.containsOnce(parent.el, ".o-reward");
        assert.containsOnce(parent.el, ".o-reward-rainbow");
        assert.strictEqual(
            parent.el.querySelector(".o-reward-msg-content").textContent,
            "<div>Congrats!</div>"
        );
    });
});
