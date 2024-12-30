export * from './mail_alias';
export * from './models';

// mixin
export * from './mail_activity_mixin';
export * from './mail_alias_mixin';
export * from './mail_render_mixin';
export * from './mail_composer_mixin';
export * from './mail_thread';
export * from './mail_thread_blacklist';
export * from './mail_thread_cc';

// mail models
export * from './mail_notification';  // keep before as decorated m2m
export * from './mail_activity_type';
export * from './mail_activity';
export * from './mail_blacklist';
export * from './mail_followers';
export * from './mail_message_reaction';
export * from './mail_message_subtype';
export * from './mail_message';
export * from './mail_mail';
export * from './mail_tracking_value';
export * from './mail_template';

// discuss
export * from './mail_channel_partner';
export * from './mail_channel_rtc_session';
export * from './mail_channel';
export * from './mail_guest';
export * from './mail_ice_server';
export * from './mail_shortcode';
export * from './res_users_settings';
export * from './res_users_settings_volumes';

// verp models
export * from './bus_presence';
export * from './ir_action_actwindow';
export * from './ir_actions_server';
export * from './ir_attachment';
export * from './ir_config_parameter';
export * from './ir_http';
export * from './ir_model';
export * from './ir_model_fields';
export * from './ir_translation';
export * from './ir_ui_view';
export * from './res_company';
export * from './res_config_settings';
export * from './res_partner';
export * from './res_users';
export * from './res_groups';
export * from './update';
