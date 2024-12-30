/** @verp-module **/

import { browser } from "../browser/browser";
import { Dialog } from "../dialog/dialog";
import { _lt } from "../l10n/translation";
import { registry } from "../registry";
import { useService } from "@web/core/utils/hooks";
import { capitalize } from "../utils/strings";

const { hooks } = owl;
const { useState } = hooks;

export const verpExceptionTitleMap = new Map(
    Object.entries({
        "verp.addons.base.models.irMailServer.MailDeliveryException": _lt(
            "MailDeliveryException"
        ),
        "verp.exceptions.AccessDenied": _lt("Access Denied"),
        "verp.exceptions.MissingError": _lt("Missing Record"),
        "verp.exceptions.UserError": _lt("User Error"),
        "verp.exceptions.ValidationError": _lt("Validation Error"),
        "verp.exceptions.AccessError": _lt("Access Error"),
        "verp.exceptions.Warning": _lt("Warning"),
    })
);

// -----------------------------------------------------------------------------
// Generic Error Dialog
// -----------------------------------------------------------------------------
export class ErrorDialog extends Dialog {
    setup() {
        super.setup();
        this.state = useState({
            showTraceback: false,
        });
    }
    onClickClipboard() {
        browser.navigator.clipboard.writeText(
            `${this.props.name}\n${this.props.message}\n${this.props.traceback}`
        );
    }
}
ErrorDialog.contentClass = "o-dialog-error";
ErrorDialog.bodyTemplate = "web.ErrorDialogBody";
ErrorDialog.title = _lt("Verp Error");

// -----------------------------------------------------------------------------
// Client Error Dialog
// -----------------------------------------------------------------------------
export class ClientErrorDialog extends ErrorDialog {}
ClientErrorDialog.title = _lt("Verp Client Error");

// -----------------------------------------------------------------------------
// Network Error Dialog
// -----------------------------------------------------------------------------
export class NetworkErrorDialog extends ErrorDialog {}
NetworkErrorDialog.title = _lt("Verp Network Error");

// -----------------------------------------------------------------------------
// RPC Error Dialog
// -----------------------------------------------------------------------------
export class RPCErrorDialog extends ErrorDialog {
    setup() {
        super.setup();
        this.inferTitle();
        this.traceback = this.props.traceback;
        if (this.props.data && this.props.data.debug) {
            this.traceback = `${this.props.data.debug}`;
        }
    }
    inferTitle() {
        // If the server provides an exception name that we have in a registry.
        if (this.props.exceptionName && verpExceptionTitleMap.has(this.props.exceptionName)) {
            this.title = verpExceptionTitleMap.get(this.props.exceptionName).toString();
            return;
        }
        // Fall back to a name based on the error type.
        if (!this.props.type) return;
        switch (this.props.type) {
            case "server":
                this.title = this.env._t("Verp Server Error");
                break;
            case "script":
                this.title = this.env._t("Verp Client Error");
                break;
            case "network":
                this.title = this.env._t("Verp Network Error");
                break;
        }
    }

    onClickClipboard() {
        browser.navigator.clipboard.writeText(
            `${this.props.name}\n${this.props.message}\n${this.traceback}`
        );
    }
}

// -----------------------------------------------------------------------------
// Warning Dialog
// -----------------------------------------------------------------------------
export class WarningDialog extends Dialog {
    setup() {
        super.setup();
        this.title = this.env._t("Verp Warning");
        this.inferTitle();
        const { data, message } = this.props;
        if (data && data.arguments && data.arguments.length > 0) {
            this.message = data.arguments[0];
        } else {
            this.message = message;
        }
    }
    inferTitle() {
        if (this.props.exceptionName && verpExceptionTitleMap.has(this.props.exceptionName)) {
            this.title = verpExceptionTitleMap.get(this.props.exceptionName).toString();
        }
    }
}
WarningDialog.bodyTemplate = "web.WarningDialogBody";

// -----------------------------------------------------------------------------
// Redirect Warning Dialog
// -----------------------------------------------------------------------------
export class RedirectWarningDialog extends Dialog {
    setup() {
        super.setup();
        this.actionService = useService("action");
        const { data, subType } = this.props;
        const [message, actionId, buttonText, additionalContext] = data.arguments;
        this.title = capitalize(subType) || this.env._t("Verp Warning");
        this.message = message;
        this.actionId = actionId;
        this.buttonText = buttonText;
        this.additionalContext = additionalContext;
    }
    async onClick() {
        const options = {};
        if (this.additionalContext) {
            options.additionalContext = this.additionalContext;
        }
        await this.actionService.doAction(this.actionId, options);
        this.close();
    }
    onCancel() {
        this.close();
    }
}
RedirectWarningDialog.bodyTemplate = "web.RedirectWarningDialogBody";
RedirectWarningDialog.footerTemplate = "web.RedirectWarningDialogFooter";

// -----------------------------------------------------------------------------
// Error 504 Dialog
// -----------------------------------------------------------------------------
export class Error504Dialog extends Dialog {}
Error504Dialog.bodyTemplate = "web.Error504DialogBody";
Error504Dialog.title = _lt("Request timeout");

// -----------------------------------------------------------------------------
// Expired Session Error Dialog
// -----------------------------------------------------------------------------
export class SessionExpiredDialog extends Dialog {
    onClick() {
        browser.location.reload();
    }
}
SessionExpiredDialog.bodyTemplate = "web.SessionExpiredDialogBody";
SessionExpiredDialog.footerTemplate = "web.SessionExpiredDialogFooter";
SessionExpiredDialog.title = _lt("Verp Session Expired");

registry
    .category("errorDialogs")
    .add("verp.exceptions.AccessDenied", WarningDialog)
    .add("verp.exceptions.AccessError", WarningDialog)
    .add("verp.exceptions.MissingError", WarningDialog)
    .add("verp.exceptions.UserError", WarningDialog)
    .add("verp.exceptions.ValidationError", WarningDialog)
    .add("verp.exceptions.RedirectWarning", RedirectWarningDialog)
    .add("verp.exceptions.SessionExpiredException", SessionExpiredDialog)
    .add("verp.exceptions.Forbidden", SessionExpiredDialog)
    .add("504", Error504Dialog);
