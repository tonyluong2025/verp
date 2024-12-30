/** @verp-module **/

import { browser } from "@web/core/browser/browser";
import AbstractAction from "web.AbstractAction";
import core from "web.core";
import * as LegacyRegistry from "web.Registry";
import { registerCleanup } from "../../helpers/cleanup";
import { nextTick, patchWithCleanup } from "../../helpers/utils";
import { createWebClient, doAction } from "../../webclient/helpers";

let legacyParams;

QUnit.module("Service Provider Adapter Notification", (hooks) => {
  hooks.beforeEach(() => {
    legacyParams = {
      serviceRegistry: new LegacyRegistry(),
    };
  });

  QUnit.test(
    "can display and close a sticky danger notification with a title (legacy)",
    async function (assert) {
      assert.expect(8);
      let notifId;
      let timeoutCB;
      patchWithCleanup(browser, {
        setTimeout: (cb, delay) => {
            if (!delay) {
                return; // Timeouts from router service
            }
            timeoutCB = cb;
            assert.step("time: " + delay);
            return 1;
        },
      });
      const NotifyAction = AbstractAction.extend({
        onAttachCallback() {
          notifId = this.call("notification", "notify", {
            title: "Some title",
            message: "I'm a danger notification",
            type: "danger",
            sticky: true,
          });
        },
      });
      const CloseAction = AbstractAction.extend({
        onAttachCallback() {
          this.call("notification", "close", notifId, false, 3000);
        },
      });
      core.actionRegistry.add("NotifyTestLeg", NotifyAction);
      core.actionRegistry.add("CloseTestLeg", CloseAction);
      registerCleanup(() => {
        delete core.actionRegistry.map.NotifyTestLeg;
        delete core.actionRegistry.map.CloseTestLeg;
      });
      const webClient = await createWebClient({ legacyParams });
      await doAction(webClient, "NotifyTestLeg");
      await nextTick();
      assert.containsOnce(document.body, ".o-notification");
      const notif = document.body.querySelector(".o-notification");
      assert.strictEqual(notif.querySelector(".o-notification-title").textContent, "Some title");
      assert.strictEqual(
        notif.querySelector(".o-notification-content").textContent,
        "I'm a danger notification"
      );
      assert.hasClass(notif, "bg-danger");

      //Close the notification
      await doAction(webClient, "CloseTestLeg");
      await nextTick();
      assert.containsOnce(document.body, ".o-notification");
      // simulate end of timeout
      timeoutCB();
      await nextTick();
      assert.containsNone(document.body, ".o-notification");
      assert.verifySteps(["time: 3000"]);
    }
  );
});
