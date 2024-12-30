verp.define('web_editor.loader', function (require) {
'use strict';

var ajax = require('web.ajax');

let wysiwygPromise;

const exports = {};

function loadWysiwyg(additionnalAssets=[]) {
    return ajax.loadLibs({assetLibs: ['web_editor.compiledAssetsWysiwyg', ...additionnalAssets]}, undefined, '/web_editor/publicRenderTemplate');
}
exports.loadWysiwyg = loadWysiwyg;

/**
 * Load the assets and create a wysiwyg.
 *
 * @param {Widget} parent The wysiwyg parent
 * @param {object} options The wysiwyg options
 */
exports.createWysiwyg = async (parent, options, additionnalAssets = []) => {
    const wysiwygAlias = options.wysiwygAlias || 'web_editor.wysiwyg';
    if (!wysiwygPromise) {
        wysiwygPromise = new Promise(async (resolve) => {
            await loadWysiwyg(additionnalAssets);
            // Wait the loading of the service and his dependencies (use string to
            // avoid parsing of require function).
            const stringFunction = `return new Promise(resolve => {
                verp.define('${wysiwygAlias}.loaded', require => {
                    ` + 'require' + `('${wysiwygAlias}');
                    resolve();
                });
            });`;
            await new Function(stringFunction)();
            resolve();
        });
    }
    await wysiwygPromise;
    const Wysiwyg = verp.__DEBUG__.services[wysiwygAlias];
    return new Wysiwyg(parent, options);
};

exports.loadFromTextarea = async (parent, textarea, options) => {
    var loading = textarea.nextElementSibling;
    if (loading && !loading.classList.contains('o-wysiwyg-loading')) {
        loading = null;
    }
    const $textarea = $(textarea);
    const currentOptions = Object.assign({}, options);
    currentOptions.value = currentOptions.value || $textarea.val() || '';
    if (!currentOptions.value.trim()) {
        currentOptions.value = '<p><br></p>';
    }
    const wysiwyg = await exports.createWysiwyg(parent, currentOptions);

    const $wysiwygWrapper = $textarea.closest('.o-wysiwyg-textarea-wrapper');
    const $form = $textarea.closest('form');

    // hide and append the $textarea in $form so it's value will be send
    // through the form.
    $textarea.hide();
    $form.append($textarea);
    $wysiwygWrapper.html('');

    await wysiwyg.appendTo($wysiwygWrapper);
    $form.find('.note-editable').data('wysiwyg', wysiwyg);

    // o-we-selected-image has not always been removed when
    // saving a post so we need the line below to remove it if it is present.
    $form.find('.note-editable').find('img.o-we-selected-image').removeClass('o-we-selected-image');
    $form.on('click', 'button[type=submit]', (e) => {
        $form.find('.note-editable').find('img.o-we-selected-image').removeClass('o-we-selected-image');
        // float-left class messes up the post layout OPW 769721
        $form.find('.note-editable').find('img.float-left').removeClass('float-left');
        $textarea.html(wysiwyg.getValue());
    });

    return wysiwyg;
};

return exports;
});
