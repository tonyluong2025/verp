/** @verp-module **/

import MailEmojisMixin from '@mail/js/emojis_mixin';
import FieldEmojiCommon from '@mail/js/field_emojis_common';

import basicFields from 'web.basicFields';
import registry from 'web.fieldRegistry';

/**
 * Extension of the FieldText that will add emojis support
 */
var FieldTextEmojis = basicFields.FieldText.extend(MailEmojisMixin, FieldEmojiCommon);

registry.add('textEmojis', FieldTextEmojis);

export default FieldTextEmojis;
