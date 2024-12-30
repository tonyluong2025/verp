/** @verp-module **/

import { browser } from "../core/browser/browser";
import AbstractStorageService from "web.AbstractStorageService";
import {
    ConnectionAbortedError,
    RPCError,
    makeErrorFromResponse,
    ConnectionLostError,
} from "../core/network/rpc_service";
import { ErrorDialog } from "../core/errors/error_dialogs";

export function makeLegacyRpcService(legacyEnv) {
    return {
        start(env) {
            legacyEnv.bus.on("rpcRequest", null, (rpcId) => {
                env.bus.trigger("RPC:REQUEST", rpcId);
            });
            legacyEnv.bus.on("rpcResponse", null, (rpcId) => {
                env.bus.trigger("RPC:RESPONSE", rpcId);
            });
            legacyEnv.bus.on("rpcResponseFailed", null, (rpcId) => {
                env.bus.trigger("RPC:RESPONSE", rpcId);
            });
        },
    };
}

/**
 * Returns a service that maps legacy dialogs
 * to new environment services behavior.
 *
 * @param {object} legacyEnv
 * @returns a wowl deployable service
 */
export function makeLegacyDialogMappingService(legacyEnv) {
    return {
        dependencies: ["ui", "hotkey"],
        start(env) {
            const { ui, hotkey } = env.services;

            function getModalEl(dialog) {
                return dialog.modalRef ? dialog.modalRef.el : dialog.$modal[0];
            }

            function getCloseCallback(dialog) {
                return dialog.modalRef ? () => dialog._close() : () => dialog.$modal.modal("hide");
            }

            const dialogHotkeyRemoveMap = new Map();

            function onOpenDialog(dialog) {
                ui.activateElement(getModalEl(dialog));
                const remove = hotkey.add("escape", getCloseCallback(dialog));
                dialogHotkeyRemoveMap.set(dialog, remove);
            }

            function onCloseDialog(dialog) {
                ui.deactivateElement(getModalEl(dialog));
                if (dialogHotkeyRemoveMap.has(dialog)) {
                    const removeHotkey = dialogHotkeyRemoveMap.get(dialog);
                    removeHotkey();
                    dialogHotkeyRemoveMap.delete(dialog);
                }
            }

            legacyEnv.bus.on("legacyDialogOpened", null, onOpenDialog);
            legacyEnv.bus.on("legacyDialogDestroyed", null, onCloseDialog);

            legacyEnv.bus.on("owlDialogMounted", null, onOpenDialog);
            legacyEnv.bus.on("owlDialogWillunmount", null, onCloseDialog);
        },
    };
}

/**
 * Deploys a service allowing legacy to add/remove commands.
 *
 * @param {object} legacyEnv
 * @returns a wowl deployable service
 */
export function makeLegacyCommandService(legacyEnv) {
    return {
        dependencies: ["command"],
        start(env) {
            const { command } = env.services;

            const commandRemoveMap = new Map();

            function setLegacyCommand(uniqueId, getCommandDefinition) {
                const { name, action, options } = getCommandDefinition(env);
                removeLegacyCommand(uniqueId);
                commandRemoveMap.set(uniqueId, command.add(name, action, options));
            }

            function removeLegacyCommand(uniqueId) {
                if (commandRemoveMap.has(uniqueId)) {
                    const removeCommand = commandRemoveMap.get(uniqueId);
                    removeCommand();
                    commandRemoveMap.delete(uniqueId);
                }
            }

            legacyEnv.bus.on("setLegacyCommand", null, setLegacyCommand);
            legacyEnv.bus.on("removeLegacyCommand", null, removeLegacyCommand);
        },
    };
}

export function makeLegacyDropdownService(legacyEnv) {
    return {
        dependencies: ["ui", "hotkey"],
        start(_, { ui, hotkey }) {
            legacyEnv.services.ui = ui;
            legacyEnv.services.hotkey = hotkey;
        },
    };
}

export function makeLegacySessionService(legacyEnv, session) {
    return {
        dependencies: ["user"],
        start(env) {
            // userContext, Object.create is incompatible with legacy new Context
            function mapContext() {
                return Object.assign({}, env.services.user.context);
            }
            Object.defineProperty(legacyEnv.session, "userContext", {
                get: () => mapContext(),
            });
            Object.defineProperty(session, "userContext", {
                get: () => mapContext(),
            });
        },
    };
}

export function mapLegacyEnvToWowlEnv(legacyEnv, wowlEnv) {
    // rpc
    legacyEnv.session.rpc = (...args) => {
        let rejection;
        const prom = new Promise((resolve, reject) => {
            const [route, params, settings = {}] = args;
            // Add user context in kwargs if there are kwargs
            if (params && params.kwargs) {
                params.kwargs.context = Object.assign(
                    {},
                    legacyEnv.session.userContext,
                    params.kwargs.context,
                );
            }
            const jsonrpc = wowlEnv.services.rpc(route, params, {
                silent: settings.shadow,
                xhr: settings.xhr,
            });
            rejection = () => {
                jsonrpc.abort();
            };
            jsonrpc.then(resolve).catch((reason) => {
                if (reason instanceof RPCError || reason instanceof ConnectionLostError) {
                    // we do not reject an error here because we want to pass through
                    // the legacy guardedCatch code
                    reject({ message: reason, event: $.Event(), legacy: true });
                } else if (reason instanceof ConnectionAbortedError) {
                    reject({ message: reason.message, event: $.Event("abort") });
                } else {
                    reject(reason);
                }
            });
        });
        prom.abort = rejection;
        return prom;
    };
    // Storages
    function mapStorage(storage) {
        const StorageService = AbstractStorageService.extend({ storage });
        return new StorageService();
    }

    legacyEnv.services.localStorage = mapStorage(browser.localStorage);
    legacyEnv.services.sessionStorage = mapStorage(browser.sessionStorage);
    // map WebClientReady
    wowlEnv.bus.on("WEB_CLIENT_READY", null, () => {
        legacyEnv.bus.trigger("webClientReady");
    });

    wowlEnv.bus.on("SCROLLER:ANCHOR_LINK_CLICKED", null, (payload) => {
        legacyEnv.bus.trigger("SCROLLER:ANCHOR_LINK_CLICKED", payload);
    });

    legacyEnv.bus.on("clearCache", null, () => {
        wowlEnv.bus.trigger("CLEAR-CACHES");
    });
}

const reBSTooltip = /^bs-.*$/;

export function cleanDomFromBootstrap() {
    const body = document.body;
    // multiple bodies in tests
    // Bootstrap tooltips
    const tooltips = body.querySelectorAll("body .tooltip");
    for (const tt of tooltips) {
        if (Array.from(tt.classList).find((cls) => reBSTooltip.test(cls))) {
            tt.parentNode.removeChild(tt);
        }
    }
}

export function makeLegacyNotificationService(legacyEnv) {
    return {
        dependencies: ["notification"],
        start(env) {
            let notifId = 0;
            const idsToRemoveFn = {};

            function notify({
                title,
                message,
                subtitle,
                buttons = [],
                sticky,
                type,
                className,
                onClose,
            }) {
                if (subtitle) {
                    title = [title, subtitle].filter(Boolean).join(" ");
                }
                if (!message && title) {
                    message = title;
                    title = undefined;
                }

                buttons = buttons.map((button) => {
                    return {
                        name: button.text,
                        icon: button.icon,
                        primary: button.primary,
                        onClick: button.click,
                    };
                });

                const removeFn = env.services.notification.add(_.escape(message), {
                    sticky,
                    title,
                    type,
                    className,
                    onClose,
                    buttons,
                    messageIsHtml: true,
                });
                const id = ++notifId;
                idsToRemoveFn[id] = removeFn;
                return id;
            }

            function close(id, _, wait) {
                //the legacy close method had 3 arguments : the notification id, silent and wait.
                //the new close method only has 2 arguments : the notification id and wait.
                const removeFn = idsToRemoveFn[id];
                delete idsToRemoveFn[id];
                if (wait) {
                    browser.setTimeout(() => {
                        removeFn(id);
                    }, wait);
                } else {
                    removeFn(id);
                }
            }

            legacyEnv.services.notification = { notify, close };
        },
    };
}

export function makeLegacyCrashManagerService(legacyEnv) {
    return {
        dependencies: ["dialog"],
        start(env) {
            legacyEnv.services.crashManager = {
                showMessage(message) {
                    env.services.dialog.add(ErrorDialog, { traceback: message });
                },
                rpcError(errorResponse) {
                    // Will be handled by errorService
                    Promise.reject(makeErrorFromResponse(errorResponse));
                },
            };
        },
    };
}

export function wrapSuccessOrFail(promise, { onSuccess, onFail } = {}) {
    return promise.then(onSuccess || (() => {})).catch((reason) => {
        let alreadyThrown = false;
        if (onFail) {
            alreadyThrown = onFail(reason) === "alreadyThrown";
        }
        if (reason instanceof Error && !alreadyThrown) {
            throw reason;
        }
    });
}

export function makeLegacyRainbowManService(legacyEnv) {
    return {
        dependencies: ["effect"],
        start(env, { effect }) {
            legacyEnv.bus.on("show-effect", null, (payload) => {
                effect.add(payload);
            });
        },
    };
}
