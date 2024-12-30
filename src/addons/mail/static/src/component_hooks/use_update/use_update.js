/** @verp-module **/

import { Listener } from '@mail/model/model_listener';

const { onMounted, onPatched, useComponent } = owl.hooks;

/**
 * This hook provides support for executing code after update (render or patch).
 *
 * @param {Object} param0
 * @param {function} param0.func the function to execute after the update.
 */
export function useUpdate({ func }) {
    const component = useComponent();
    const { modelManager } = component.env.services.messaging;
    const listener = new Listener({
        isLocking: false, // unfortunately onupdate methods often have side effect
        name: `useUpdate() of ${component}`,
        onchange: () => component.render(),
    });
    function onupdate() {
        if (modelManager) {
            modelManager.startListening(listener);
        }
        func();
        if (modelManager) {
            modelManager.stopListening(listener);
        }
    }
    onMounted(onupdate);
    onPatched(onupdate);
    const __destroy = component.__destroy;
    component.__destroy = parent => {
        if (modelManager) {
            modelManager.removeListener(listener);
        }
        __destroy.call(component, parent);
    };
}
