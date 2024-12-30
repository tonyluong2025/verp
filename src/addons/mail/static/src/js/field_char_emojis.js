/** @verp-module **/

import MailEmojisMixin from '@mail/js/emojis_mixin';
import FieldEmojiCommon from '@mail/js/field_emojis_common';

import basicFields from 'web.basicFields';
import registry from 'web.fieldRegistry';

/**
 * Extension of the FieldChar that will add emojis support
 */
var FieldCharEmojis = basicFields.FieldChar.extend(MailEmojisMixin, FieldEmojiCommon);

registry.add('charEmojis', FieldCharEmojis);

export default FieldCharEmojis;
