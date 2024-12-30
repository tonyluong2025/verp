import Imap from "imap";
import { Fields, _Datetime, api } from "../../../core";
import { UserError, ValueError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { _f, bool, isInstance, range, ustr } from "../../../core/tools";

const MAX_POP_MESSAGES = 50;
const MAIL_TIMEOUT = 60;
const MAXLINE = 65536;

/**
 * Incoming POP/IMAP mail server account
 */
@MetaModel.define()
class FetchmailServer extends Model {
    static _module = module;
    static _name = 'fetchmail.server';
    static _description = 'Incoming Mail Server';
    static _order = 'priority';

    static label = Fields.Char('Name', {required: true});
    static active = Fields.Boolean('Active', {default: true});
    static state = Fields.Selection([
        ['draft', 'Not Confirmed'],
        ['done', 'Confirmed'],
    ], {string: 'Status', index: true, readonly: true, copy: false, default: 'draft'});
    static server = Fields.Char({string: 'Server Name', readonly: true, help: "Hostname or IP of the mail server", states: {'draft': [['readonly', false]]}});
    static port = Fields.Integer({readonly: true, states: {'draft': [['readonly', false]]}});
    static serverType = Fields.Selection([
        ['pop', 'POP Server'],
        ['imap', 'IMAP Server'],
        ['local', 'Local Server'],
    ], {string: 'Server Type', index: true, required: true, default: 'pop'});
    static isSsl = Fields.Boolean('SSL/TLS', {help: "Connections are encrypted with SSL/TLS through a dedicated port (default: IMAPS=993, POP3S=995)"});
    static attach = Fields.Boolean('Keep Attachments', {help: "Whether attachments should be downloaded. If not enabled, incoming emails will be stripped of any attachments before being processed", default: true});
    static original = Fields.Boolean('Keep Original', {help: "Whether a full original copy of each email should be kept for reference and attached to each processed message. This will usually double the size of your message database."});
    static date = Fields.Datetime({string: 'Last Fetch Date', readonly: true});
    static user = Fields.Char({string: 'Username', readonly: true, states: {'draft': [['readonly', false]]}});
    static password = Fields.Char({readonly: true, states: {'draft': [['readonly', false]]}});
    static objectId = Fields.Many2one('ir.model', {string: "Create a New Record", help: "Process each incoming mail as part of a conversation corresponding to this document type. This will create new documents for new conversations, or attach follow-up emails to the existing conversations (documents)."});
    static priority = Fields.Integer({string: 'Server Priority', readonly: true, states: {'draft': [['readonly', false]]}, help: "Defines the order of processing, lower values mean higher priority", default: 5});
    static messageIds = Fields.One2many('mail.mail', 'fetchmailServerId', { string: 'Messages', readonly: true});
    static configuration = Fields.Text('Configuration', {readonly: true});
    static script = Fields.Char({readonly: true, default: '/mail/static/scripts/verp-mailgate.js'});

    @api.onchange('serverType', 'isSsl', 'objectId')
    async onchangeServerType() {
        await this.set('port', 0);
        if (await this['serverType'] === 'pop') {
            await this.set('port', await this['isSsl'] && 995 || 110);
        }
        else if (await this['serverType'] === 'imap') {
            await this.set('port', await this['isSsl'] && 993 || 143);
        }

        const conf = {
            'dbName': this.env.cr.dbName,
            'uid': this.env.uid,
            'model': bool(await this['objectId']) ? await (await this['objectId']).model : 'MODELNAME'
        }
        await this.set('configuration', _f(`Use the below script with the following command line options with your Mail Transport Agent (MTA)
verp-mailgate.js --host=HOSTNAME --port=PORT -u {uid} -p PASSWORD -d {dbname}
Example configuration for the postfix mta running locally:
/etc/postfix/virtual_aliases: @youdomain verpmailgate@localhost
/etc/aliases:
verp_mailgate: "|/path/to/verp-mailgate.js --host=localhost -u {uid} -p PASSWORD -d {dbname}`, conf))
    }

    @api.modelCreateMulti()
    async create(valsList) {
        const res = await _super(FetchmailServer, this).create(valsList);
        await this._updateCron();
        return res;
    }

    async write(values) {
        const res = await _super(FetchmailServer, this).write(values);
        await this._updateCron();
        return res;
    }

    async unlink() {
        const res = await _super(FetchmailServer, self).unlink();
        await this._updateCron();
        return res;
    }

    async setDraft() {
        await this.write({'state': 'draft'});
        return true;
    }

    async connect() {
        this.ensureOne();
        let connection;
        if (await this['serverType'] === 'imap') {
            connection = new Imap({
                user: await this['user'],
                password: await this['password'],
                host: 'imap.gmail.com',
                port: await this['port'],
                tls: await this['isSsl']
            });
            // this._imapLogin(connection);
        }
        else if (await this['serverType'] === 'pop') {
            // if self.is_ssl:
            //     connection = POP3_SSL(self.server, int(self.port), timeout=MAIL_TIMEOUT)
            // else:
            //     connection = POP3(self.server, int(self.port), timeout=MAIL_TIMEOUT)
            // #TODO: use this to remove only unread messages
            // #connection.user("recent:"+server.user)
            // connection.user(self.user)
            // connection.pass_(self.password)
        }
        return connection;
    }

    /**
     * Authenticate the IMAP connection.
        Can be overridden in other module for different authentication methods.
        :param connection: The IMAP connection to authenticate
     * @param connection 
     */
    async _imapLogin(connection) {
        this.ensureOne();
        connection.login(await this['user'], await this['password']);
    }

    async buttonConfirmLogin() {
        for (const server of this) {
            let connection;
            try {
                connection = await server.connect();
                server.write({'state': 'done'})
            } catch(e) {
            // except UnicodeError as e:
            //     raise UserError(_("Invalid server name !\n %s", tools.ustr(e)))
            // except (gaierror, timeout, IMAP4.abort) as e:
            //     raise UserError(_("No response received. Check server information.\n %s", tools.ustr(e)))
            // except (IMAP4.error, poplib.error_proto) as err:
            //     raise UserError(_("Server replied with following exception:\n %s", tools.ustr(err)))
            // except SSLError as e:
            //     raise UserError(_("An SSL exception occurred. Check SSL/TLS configuration on server port.\n %s", tools.ustr(e)))
            // except (OSError, Exception) as err:
                console.info("Failed to connect to %s server %s.", server.serverType, server.label);
                throw new UserError(await this._t("Connection test failed: %s", ustr(e)));
            }
            finally {
                try {
                    if (connection) {
                        if (await server.serverType === 'imap') {
                            await connection.close();
                        }
                        else if (await server.serverType === 'pop') {
                            await connection.quit();
                        }
                    }
                } catch(e) {
                    // ignored, just a consequence of the previous exception
                    // pass
                }
            }
        }
        return true;
    }

    /**
     * Method called by cron to fetch mails from servers
     * @returns 
     */
    @api.model()
    async _fetchMails() {
        return (await this.search([['state', '=', 'done'], ['serverType', 'in', ['pop', 'imap']]])).fetchMail();
    }

    /**
     * WARNING: meant for cron usage only - will commit() after each email!
     * @returns 
     */
    async fetchMail() {
        const additionnalContext = {
            'fetchmailCronRunning': true
        }
        const mailThread = this.env.items('mail.thread');
        for (const server of this) {
            const [serverType, serverLabel] = await server('serverType', 'label');
            console.info('start checking for new emails on %s server %s', serverType, serverLabel);
            additionnalContext['default_fetchmailServerId'] = server.id;
            let [count, failed] = [0, 0];
            let imapServer, popServer;
            if (serverType === 'imap') {
                try {
                    const imapServer = await server.connect();
                    await imapServer.select();
                    let [result, data] = await imapServer.search(null, '(UNSEEN)');
                    for (const num of data[0].replace('  ', ' ').split(' ')) {
                        let resId;
                        [result, data] = await imapServer.fetch(num, '(RFC822)');
                        await imapServer.store(num, '-FLAGS', '\\Seen');
                        try {
                            resId = await (await mailThread.withContext(additionnalContext)).messageProcess(await (await server.objectId).model, data[0][1], {saveOriginal: await server.original, stripAttachments: !await server.attach});
                        } catch(e) {
                            console.info('Failed to process mail from %s server %s.', serverType, serverLabel);
                            failed += 1
                        }
                        await imapServer.store(num, '+FLAGS', '\\Seen');
                        await this._cr.commit();
                        count += 1;
                    }
                    console.info("Fetched %s email(s) on %s server %s; %s succeeded, %s failed.", count, serverType, serverLabel, (count - failed), failed);
                } catch(e) {
                    console.info("General failure when trying to fetch mail from %s server %s.", serverType, serverLabel);
                }
                finally {
                    if (imapServer) {
                        await imapServer.close()
                        await imapServer.logout()
                    }
                }
            }
            else if (await server.serverType === 'pop') {
                try {
                    while (true) {
                        let failedInLoop = 0;
                        let num = 0;
                        popServer = await server.connect();
                        const [numMessages, totalSize] = await popServer.stat();
                        await popServer.list();
                        for (num of range(1, Math.min(MAX_POP_MESSAGES, numMessages) + 1)) {
                            const [header, messages, octets] = await popServer.retr(num);
                            const message = messages.join('\n');
                            let resId;
                            try {
                                resId = await (await mailThread.withContext(additionnalContext)).messageProcess(await (await server.objectId).model, message, {saveOriginal: await server.original, stripAttachments: ! await server.attach});
                                await popServer.dele(num);
                            } catch(e) {
                                console.info('Failed to process mail from %s server %s.', serverType, serverLabel);
                                failed += 1;
                                failedInLoop += 1;
                            }
                            await this.env.cr.commit();
                        }
                        console.info("Fetched %d email(s) on %s server %s; %s succeeded, %s failed.", num, serverType, serverLabel, (num - failedInLoop), failedInLoop);
                        // Stop if (1) no more message left or (2) all messages have failed
                        if (numMessages < MAX_POP_MESSAGES || failedInLoop === num) {
                            break;
                        }
                        await popServer.quit();
                    }
                } catch(e) {
                    console.info("General failure when trying to fetch mail from %s server %s.", serverType, serverLabel);
                }
                finally {
                    if (popServer) {
                        await popServer.quit();
                    }
                }
            }
            await server.write({'date': _Datetime.now()});
        }
        return true;
    }

    @api.model()
    async _updateCron() {
        if (this.env.context['fetchmailCronRunning']) {
            return;
        }
        try {
            // Enabled/Disable cron based on the number of 'done' server of type pop or imap
            const cron = await this.env.ref('fetchmail.irCronMailGatewayAction');
            await cron.toggle(this._name, [['state', '=', 'done'], ['serverType', 'in', ['pop', 'imap']]]);
        } catch(e) {
            if (!isInstance(e, ValueError)) {
                throw e;
            }
        }
    }
}