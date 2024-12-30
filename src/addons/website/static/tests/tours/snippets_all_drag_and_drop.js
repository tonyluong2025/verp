verp.define("website.tour.snippets_all_drag_and_drop", async function (require) {
"use strict";

const snippetsEditor = require('web_editor.snippet.editor');

snippetsEditor.SnippetEditor.include({
    removeSnippet: async function (shouldRecordUndo = true) {
        await this._super(...arguments);
        $('body').attr('test-dd-snippet-removed', true);
    },
});

const tour = require("web_tour.tour");

let snippetsNames = (new URL(document.location.href)).searchParams.get('snippetsNames') || '';
snippetsNames = snippetsNames.split(',');
let steps = [];
let n = 0;
for (const snippet of snippetsNames) {
    n++;
    const snippetSteps = [{
        content: `Drop ${snippet} snippet [${n}/${snippetsNames.length}]`,
        trigger: `#oeSnippets .oe-snippet:has( > [data-snippet='${snippet}']) .oe-snippet-thumbnail`,
        run: "dragAndDrop #wrap",
    }, {
        content: `Edit ${snippet} snippet`,
        trigger: `#wrap.o-editable [data-snippet='${snippet}']`,
    }, {
        content: `check ${snippet} setting are loaded, wait panel is visible`,
        trigger: ".o-we-customize-panel",
        run: function () {}, // it's a check
    }, {
        content: `Remove the ${snippet} snippet`, // Avoid bad perf if many snippets
        trigger: "we-button.oe-snippet-remove:last"
    }, {
        content: `click on 'BLOCKS' tab (${snippet})`,
        extraTrigger: 'body[test-dd-snippet-removed]',
        trigger: ".o-we-add_snippet_btn",
        run: function (actions) {
            $('body').removeAttr('test-dd-snippet-removed');
            actions.auto();
        },
    }];

    if (snippet === 'sGoogleMap') {
        snippetSteps.splice(1, 3, {
            content: 'Close API Key popup',
            trigger: ".modal-footer .btn-secondary",
        });
    } else if (['sPopup', 's_newsletter_subscribe_popup'].includes(snippet)) {
        snippetSteps[2]['inModal'] = false;
        snippetSteps.splice(3, 2, {
            content: `Hide the ${snippet} popup`,
            trigger: ".s-popup-close",
        });
    }
    steps = steps.concat(snippetSteps);
}

tour.register("snippets_all_drag_and_drop", {
    test: true,
}, [
    {
        content: "Ensure snippets are actually passed at the test.",
        trigger: "body",
        run: function () {
            // safety check, otherwise the test might "break" one day and
            // receive no steps. The test would then not test anything anymore
            // without us noticing it.
            if (steps.length < 220) {
                console.error("This test is not behaving as it should.");
            }
        },
    },
    // This first step is needed as it will be used later for inner snippets
    // Without this, it will dropped inside the footer and will need an extra
    // selector.
    {
        content: "Drop sTextImage snippet",
        trigger: "#oeSnippets .oe-snippet:has( > [data-snippet='sTextImage']) .oe-snippet-thumbnail",
        run: "dragAndDrop #wrap"
    },
    {
        content: "Edit sTextImage snippet",
        trigger: "#wrap.o-editable [data-snippet='sTextImage']"
    },
    {
        content: "check setting are loaded, wait panel is visible",
        trigger: ".o-we-customize-panel"
    },
    {
        content: "click on 'BLOCKS' tab",
        trigger: ".o-we-add_snippet_btn"
    },
].concat(steps)
);
});
