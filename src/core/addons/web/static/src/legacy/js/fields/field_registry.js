verp.define('web.fieldRegistry', function (require) {
    "use strict";

    const Registry = require('web.Registry');

    return new Registry(
        null,
        (value) => !(value.prototype instanceof owl.Component)
    );
});

verp.define('web._fieldRegistry', function (require) {
"use strict";

var AbstractField = require('web.AbstractField');
var basicFields = require('web.basicFields');
var relationalFields = require('web.relationalFields');
var registry = require('web.fieldRegistry');
var specialFields = require('web.specialFields');


// Basic fields
registry
    .add('abstract', AbstractField)
    .add('input', basicFields.InputField)
    .add('integer', basicFields.FieldInteger)
    .add('boolean', basicFields.FieldBoolean)
    .add('date', basicFields.FieldDate)
    .add('datetime', basicFields.FieldDateTime)
    .add('daterange', basicFields.FieldDaterange)
    .add('remainingDays', basicFields.RemainingDays)
    .add('domain', basicFields.FieldDomain)
    .add('text', basicFields.FieldText)
    .add('list.text', basicFields.ListFieldText)
    .add('html', basicFields.FieldText)
    .add('float', basicFields.FieldFloat)
    .add('char', basicFields.FieldChar)
    .add('linkButton', basicFields.LinkButton)
    .add('handle', basicFields.HandleWidget)
    .add('email', basicFields.FieldEmail)
    .add('phone', basicFields.FieldPhone)
    .add('url', basicFields.UrlWidget)
    .add('CopyClipboardText', basicFields.TextCopyClipboard)
    .add('CopyClipboardChar', basicFields.CharCopyClipboard)
    .add('CopyClipboardURL', basicFields.URLCopyClipboard)
    .add('image', basicFields.FieldBinaryImage)
    .add('imageUrl', basicFields.CharImageUrl)
    .add('kanban.image', basicFields.KanbanFieldBinaryImage)
    .add('kanban.imageUrl', basicFields.KanbanCharImageUrl)
    .add('binary', basicFields.FieldBinaryFile)
    .add('pdfViewer', basicFields.FieldPdfViewer)
    .add('monetary', basicFields.FieldMonetary)
    .add('percentage', basicFields.FieldPercentage)
    .add('priority', basicFields.PriorityWidget)
    .add('attachmentImage', basicFields.AttachmentImage)
    .add('labelSelection', basicFields.LabelSelection)
    .add('kanbanLabelSelection', basicFields.LabelSelection) // deprecated, use labelSelection
    .add('stateSelection', basicFields.StateSelectionWidget)
    .add('list.stateSelection', basicFields.ListStateSelectionWidget)
    .add('kanbanStateSelection', basicFields.StateSelectionWidget) // deprecated, use stateSelection
    .add('booleanFavorite', basicFields.FavoriteWidget)
    .add('booleanToggle', basicFields.BooleanToggle)
    .add('statinfo', basicFields.StatInfo)
    .add('percentpie', basicFields.FieldPercentPie)
    .add('floatTime', basicFields.FieldFloatTime)
    .add('floatFactor', basicFields.FieldFloatFactor)
    .add('floatToggle', basicFields.FieldFloatToggle)
    .add('progressbar', basicFields.FieldProgressBar)
    .add('toggleButton', basicFields.FieldToggleBoolean)
    .add('dashboardGraph', basicFields.JournalDashboardGraph)
    .add('ace', basicFields.AceEditor)
    .add('color', basicFields.FieldColor)
    .add('many2oneReference', basicFields.FieldInteger)
    .add('colorPicker', basicFields.FieldColorPicker);

// Relational fields
registry
    .add('selection', relationalFields.FieldSelection)
    .add('radio', relationalFields.FieldRadio)
    .add('selectionBadge', relationalFields.FieldSelectionBadge)
    .add('many2one', relationalFields.FieldMany2One)
    .add('many2oneBarcode', relationalFields.Many2oneBarcode)
    .add('list.many2one', relationalFields.ListFieldMany2One)
    .add('kanban.many2one', relationalFields.KanbanFieldMany2One)
    .add('many2oneAvatar', relationalFields.Many2OneAvatar)
    .add('many2many', relationalFields.FieldMany2Many)
    .add('many2manyBinary', relationalFields.FieldMany2ManyBinaryMultiFiles)
    .add('many2manyTags', relationalFields.FieldMany2ManyTags)
    .add('many2manyTagsAvatar', relationalFields.FieldMany2ManyTagsAvatar)
    .add('kanban.many2manyTagsAvatar', relationalFields.KanbanMany2ManyTagsAvatar)
    .add('list.many2manyTagsAvatar', relationalFields.ListMany2ManyTagsAvatar)
    .add('form.many2manyTags', relationalFields.FormFieldMany2ManyTags)
    .add('kanban.many2manyTags', relationalFields.KanbanFieldMany2ManyTags)
    .add('many2manyCheckboxes', relationalFields.FieldMany2ManyCheckBoxes)
    .add('one2many', relationalFields.FieldOne2Many)
    .add('statusbar', relationalFields.FieldStatus)
    .add('reference', relationalFields.FieldReference)
    .add('font', relationalFields.FieldSelectionFont);

// Special fields
registry
    .add('timezoneMismatch', specialFields.FieldTimezoneMismatch)
    .add('reportLayout', specialFields.FieldReportLayout)
    .add('iframeWrapper', specialFields.IframeWrapper)
});
