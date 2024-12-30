/** @verp-module **/

import { ChatWindowService } from '@mail/services/chat_window_service/chat_window_service';
import { DialogService } from '@mail/services/dialog_service/dialog_service';
import { MessagingService } from '@mail/services/messaging/messaging';
import { SystrayService } from '@mail/services/systray_service/systray_service';
import { DiscussWidget } from '@mail/widgets/discuss/discuss';

import { actionRegistry } from 'web.core';
import { serviceRegistry } from 'web.core';

serviceRegistry.add('chatWindow', ChatWindowService);
serviceRegistry.add('dialog', DialogService);
serviceRegistry.add('messaging', MessagingService);
serviceRegistry.add('systrayService', SystrayService);

actionRegistry.add('mail.widgets.discuss', DiscussWidget);
