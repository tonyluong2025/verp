import assert from "assert";
import fs from "fs/promises";
import uts46 from "idna-uts46";
import nodemailer from "nodemailer";
import tls from "tls";
import { api, tools } from "../../..";
import { getattr } from "../../../api";
import { Fields } from "../../../fields";
import { UserError } from "../../../helper";
import { MetaModel, Model } from "../../../models";
import { _f, b64decode, bool, config, emailDomainExtract, emailDomainNormalize, emailNormalize, encapsulateEmail, f, formataddr, html2Text, makeMsgid, stringPart, ustr } from "../../../tools";

const SMTP_TIMEOUT = 60;
const PROTOCOL_TLS = 'TLS_method';
const smtplib = { 'SMTP_SSL': true };
const addressPattern = new RegExp('([^ ,<@]+@[^> ,]+)', 'g');

/**
 * Returns a list of valid RFC2822 addresses
       that can be found in ``source``, ignoring
       malformed ones and non-ASCII ones.
 * @param text 
 * @returns 
 */
function extractRfc2822Addresses(text: string) {
    if (!text) {
        return [];
    }
    const candidates = ustr(text).match(addressPattern);
    const validAddresses = [];
    for (const c of candidates ?? []) {
        try {
            validAddresses.push(formataddr(['', c], 'ascii'));
        } catch (e) {
            //     pass
        }
    }
    return validAddresses;
}

function locals() {
    return {};
}

export class MailDeliveryException extends UserError { }
/**
 * Represents an SMTP server, able to send outgoing emails, with SSL and TLS capabilities.
 */
@MetaModel.define()
class IrMailServer extends Model {
    static _module = module;
    static _name = "ir.mail.server";
    static _description = 'Mail Server';
    static _order = 'sequence';

    NO_VALID_RECIPIENT = ["At least one valid recipient address should be specified for outgoing emails (To/Cc/Bcc)"];

    static label = Fields.Char({ string: 'Description', required: true, index: true });
    static fromFilter = Fields.Char("From Filter", { help: 'Define for which email address or domain this server can be used.\n e.g.: "notification@theverp.com" or "theverp.com"' });
    static smtpHost = Fields.Char({ string: 'SMTP Server', required: true, help: "Hostname or IP of SMTP server" });
    static smtpPort = Fields.Integer({ string: 'SMTP Port', required: true, default: 25, help: "SMTP Port. Usually 465 for SSL, and 25 or 587 for other cases." })
    static smtpAuthentication = Fields.Selection([['login', 'Username'], ['certificate', 'SSL Certificate']], { string: 'Authenticate with', required: true, default: 'login' });
    static smtpUser = Fields.Char({ string: 'Username', help: "Optional username for SMTP authentication", groups: 'base.groupSystem' });
    static smtpPass = Fields.Char({ string: 'Password', help: "Optional password for SMTP authentication", groups: 'base.groupSystem' });
    static smtpEncryption = Fields.Selection([['none', 'null'],
    ['starttls', 'TLS (STARTTLS)'],
    ['ssl', 'SSL/TLS']], {
        string: 'Connection Security', required: true, default: 'none', help: `Choose the connection encryption scheme:\n
    - null: SMTP sessions are done in cleartext.\n
    - TLS (STARTTLS): TLS encryption is requested at start of SMTP session (Recommended)\n
    - SSL/TLS: SMTP sessions are encrypted with SSL/TLS through a dedicated port (default: 465)`});
    static smtpSslCertificate = Fields.Binary('SSL Certificate', { groups: 'base.groupSystem', attachment: false, help: 'SSL certificate used for authentication' });
    static smtpSslPrivateKey = Fields.Binary('SSL Private Key', { groups: 'base.groupSystem', attachment: false, help: 'SSL private key used for authentication' });
    static smtpDebug = Fields.Boolean({ string: 'Debugging', help: `If enabled, the full output of SMTP sessions will be written to the server log at DEBUG level (this is very verbose and may include confidential info!)` });
    static sequence = Fields.Integer({ string: 'Priority', default: 10, help: "When no specific mail server is requested for a mail, the highest priority one is used. Default priority is 10 (smaller number = higher priority)" });
    static active = Fields.Boolean({ default: true });

    @api.constrains('smtpSslCertificate', 'smtpSslPrivateKey')
    async _checkSmtpSslFiles() {
        for (const mailServer of this) {
            if (await mailServer.smtpSslCertificate && ! await mailServer.smtpSslPrivateKey) {
                throw new UserError(await this._t('SSL private key is missing for %s.', await mailServer.label));
            }
            else if (await mailServer.smtpSslPrivateKey && ! await mailServer.smtpSslCertificate) {
                throw new UserError(await this._t('SSL certificate is missing for %s.', await mailServer.label));
            }
        }
    }

    async _getTestEmailAddresses() {
        this.ensureOne();
        const fromFilter = await this['fromFilter'];
        if (fromFilter) {
            if (fromFilter.includes('@')) {
                // All emails will be sent from the same address
                return [fromFilter, "noreply@theverp.com"];
            }
            // All emails will be sent from any address in the same domain
            const defaultFrom = await (await this.env.items("ir.config.parameter").sudo()).getParam("mail.default.from", "verp");
            return [`${defaultFrom}@${fromFilter}`, "noreply@theverp.com"];
        }
        // Fallback to current user email if there's no from filter
        const emailFrom = await (await this.env.user()).email;
        if (!emailFrom) {
            throw new UserError(await this._t('Please configure an email on the current user to simulate sending an email message via this outgoing server'));
        }
        return [emailFrom, 'noreply@theverp.com'];
    }

    async testSmtpConnection() {

        for (const server of this) {
            let smtp;
            try {
                smtp = await this.connect(server.id);
                // simulate sending an email from current user's address - without sending it!
                const [emailFrom, emailTo] = await server._getTestEmailAddresses();
                // Testing the MAIL FROM step should detect sender filter problems
                let [code, repl] = await smtp.mail(emailFrom);
                if (code != 250) {
                    throw new UserError(_f(await this._t('The server refused the sender address ({emailFrom}) with error {repl}'), locals()));
                }
                // Testing the RCPT TO step should detect most relaying problems
                [code, repl] = await smtp.rcpt(emailTo);
                if ([250, 251].includes(code)) {
                    throw new UserError(_f(await this._t('The server refused the test recipient ({emailTo}) with error %{repl}'), locals()));
                }
                // Beginning the DATA step should detect some deferred rejections
                // Can't use self.data() as it would actually send the mail!
                await smtp.putcmd("data");
                [code, repl] = await smtp.getreply();
                if (code != 354) {
                    throw new UserError(_f(await this._t('The server refused the test connection with error {repl}'), locals()));
                }
            } catch (e) {
                throw new UserError(e.message);
            }
            finally {
                try {
                    if (smtp) {
                        smtp.close();
                    }
                } catch (e) {
                    // ignored, just a consequence of the previous exception
                    //   pass
                }
            }
        }

        const message = await this._t("Connection Test Successful!");
        return {
            'type': 'ir.actions.client',
            'tag': 'displayNotification',
            'params': {
                'message': message,
                'type': 'success',
                'sticky': false,
            }
        }
    }

    /**
     * Returns a new SMTP connection to the given SMTP server.
        When running in test mode, this method does nothing and returns `null`.

        @param host host or IP of SMTP server to connect to, if mail_server_id not passed
        @param port SMTP port to connect to
        @param user optional username to authenticate with
        @param password optional password to authenticate with
        @param encryption optional, ``ssl`` | ``starttls``
        @param smtpFrom FROM SMTP envelop, used to find the best mail server
        @param sslCertificate filename of the SSL certificate used for authentication
            Used when no mail server is given and overwrite  the verp-bin argument "smtpSslCertificate"
        @param sslPrivateKey filename of the SSL private key used for authentication
            Used when no mail server is given and overwrite  the verp-bin argument "smtpSslPrivateKey"
        @param smtpDebug toggle debugging of SMTP sessions (all i/o
                            will be output in logs)
        @param mailServerId ID of specific mail server to use (overrides other parameters)
     */
    async connect(opts: {
        host?: any, port?: any, user?: any, password?: any, encryption?: any,
        smtpFrom?: any, sslCertificate?: any, sslPrivateKey?: any, smtpDebug?: boolean, mailServerId?: any
    } = {}) {
        // Do not actually connect while running in test mode
        let { host, port, user, password, encryption, smtpFrom, sslCertificate, sslPrivateKey, smtpDebug, mailServerId } = opts;
        if (this._isTestMode()) {
            return;
        }
        try {
            // tls = require('node:tls');
        } catch (err) {
            console.error('tls support is disabled!');
        }
        let mailServer, smtpEncryption;
        if (mailServerId) {
            mailServer = (await this.sudo()).browse(mailServerId);
        }
        else if (!host) {
            [mailServer, smtpFrom] = await (await this.sudo())._findMailServer(smtpFrom);
        }
        if (!bool(mailServer)) {
            mailServer = this.env.items('ir.mail.server');
        }
        let sslContext;
        let smtpUser, smtpPassword, smtpServer, smtpPort, smtpAuthentication, fromFilter;

        if (bool(mailServer)) {
            [smtpServer, smtpPort, smtpAuthentication, fromFilter] = await mailServer('smtpServer', 'smtpPort', 'smtpAuthentication', 'fromFilter');
            if (smtpAuthentication === "login") {
                [smtpUser, smtpPassword] = await mailServer('smtpUser', 'smtpPassword');
            }
            smtpEncryption = await mailServer.smtpEncryption;
            smtpDebug = smtpDebug || await mailServer.smtpDebug;
            if (smtpAuthentication === "certificate"
                && await mailServer.smtpSslCertificate
                && await mailServer.smtpSslPrivateKey) {
                try {
                    const smtpSslPrivateKey = b64decode(await mailServer.smtpSslPrivateKey);
                    // const privateKey = SSLCrypto.loadPrivatekey(FILETYPE_PEM, smtpSslPrivateKey);
                    const smtpSslCertificate = b64decode(await mailServer.smtpSslCertificate);
                    // const certificate = SSLCrypto.loadCertificate(FILETYPE_PEM, smtpSslCertificate);
                    // sslContext.useCertificate(certificate);
                    // sslContext.usePrivatekey(privateKey);
                    sslContext = tls.createSecureContext({
                        secureProtocol: PROTOCOL_TLS,
                        key: smtpSslPrivateKey,
                        cert: smtpSslCertificate,
                        sessionTimeout: 300
                    });
                    // Check that the private key match the certificate
                    // sslContext.checkPrivatekey();
                } catch (e) {
                    if (e.code === 'ERR_TLS_INVALID_CONTEXT') {
                        throw new UserError(await this._t('The private key or the certificate is not a valid file. \n%s', e));
                    }
                    if (e.code === 'SSLError') {
                        throw new UserError(await this._t('Could not load your certificate / private key. \n%s', e));
                    }
                    throw e;
                }
            }
        }
        else {
            // we were passed individual smtp parameters or nothing and there is no default server
            smtpServer = host || config.get('smtpServer');
            smtpPort = port == null ? config.get('smtpPort', 25) : port;
            smtpUser = user || config.get('smtpUser');
            smtpPassword = password || config.get('smtpPassword');
            fromFilter = await (await this.env.items('ir.config.parameter').sudo()).getParam(
                'mail.default.fromFilter', config.get('fromFilter'));
            smtpEncryption = encryption;
            if (smtpEncryption == null && config.get('smtpSsl')) {
                smtpEncryption = 'starttls' // smtp_ssl => STARTTLS as of v7
            }
            const smtpSslCertificateFilename = sslCertificate || config.get('smtpSslCertificateFilename'),
                smtpSslPrivateKeyFilename = sslPrivateKey || config.get('smtpSslPrivateKeyFilename');

            if (smtpSslCertificateFilename && smtpSslPrivateKeyFilename) {
                try {
                    const smtpSslPrivateKey = await fs.readFile(smtpSslPrivateKeyFilename);
                    const smtpSslCertificate = await fs.readFile(smtpSslCertificateFilename);
                    sslContext = tls.createSecureContext({
                        secureProtocol: PROTOCOL_TLS,
                        key: smtpSslPrivateKey,
                        cert: smtpSslCertificate,
                        sessionTimeout: 300,
                    });
                    // Check that the private key match the certificate
                    // sslContext.checkPrivatekey()
                } catch (e) {
                    if (e.code === 'ERR_TLS_INVALID_CONTEXT') {
                        throw new UserError(await this._t('The private key or the certificate is not a valid file. \n%s', e));
                    }
                    if (e.code === 'SSLError') {
                        throw new UserError(await this._t('Could not load your certificate / private key. \n%s', e));
                    }
                    throw e;
                }
            }
        }
        if (!smtpServer) {
            throw new UserError(
                (await this._t("Missing SMTP Server") + "\n" +
                    await this._t("Please define at least one SMTP server, or provide the SMTP parameters explicitly.")));
        }
        if (smtpUser) {
            // Attempt authentication - will raise if AUTH service not supported
            const [local, at, domain] = stringPart(smtpUser, '@');
            if (at) {
                smtpUser = local + at + uts46.toAscii(uts46.toUnicode(domain));
            }
        }
        // starttls() will perform ehlo() if needed first
        // and will discard the previous list of services
        // after successfully performing STARTTLS command,
        // (as per RFC 3207) so for example any AUTH
        // capability that appears only on encrypted channels
        // will be correctly detected for next step
        const connection = nodemailer.createTransport({
            host: smtpServer,
            port: smtpPort,
            secure: smtpPort == 465,        // use TLS
            requireTLS: smtpEncryption === 'starttls',
            dnsTimeout: 30 * 60,            // default 30 seconds
            socketTimeout: 10 * 60 * 60,    // default 10 minutes
            connectionTimeout: 2 * 60 * 60, // default 2 minutes
            greetingTimeout: 38 * 60,       // default 30 seconds
            auth: {
                user: smtpUser,
                pass: smtpPassword || '',
            },
            tls: {
                secureContext: sslContext
            }
        });
        // connection.setDebuglevel(smtpDebug);

        // Some methods of SMTP don't check whether EHLO/HELO was sent.
        // Anyway, as it may have been sent by login(), all subsequent usages should consider this command as sent.
        // connection.ehloOrHeloIfNeeded();

        // Store the "fromFilter" of the mail server / verp-bin argument to  know if we
        // need to change the FROM headers or not when we will prepare the mail message
        // connection.fromFilter = fromFilter
        // connection.smtpFrom = smtpFrom

        return connection;
    }

    /**
     * Authenticate the SMTP connection.
    
        Can be overridden in other module for different authentication methods.Can be
        called on the model itself or on a singleton.
    
        @param connection The SMTP connection to authenticate
        @param smtpUser The user to used for the authentication
        @param smtpPassword The password to used for the authentication
     */
    async _smtpLogin(connection: tls.TLSSocket, smtpUser, smtpPassword) {
        return nodemailer.createTransport(connection, {
            auth: {
                user: smtpUser,
                pass: smtpPassword,
            },
        });

    }

    /**
     * Constructs an RFC2822 email.message.Message object based on the keyword arguments passed, and returns it.
 
        @param emailFrom sender email address
        @param emailTo list of recipient addresses (to be joined with commas)
        @param subject email subject (no pre-encoding/quoting necessary)
        @param body email body, of the type ``subtype`` (by default, plaintext).
                            If html subtype is used, the message will be automatically converted
                            to plaintext and wrapped in multipart/alternative, unless an explicit
                            ``bodyAlternative`` version is passed.
        @param bodyAlternative optional alternative body, of the type specified in ``subtypeAlternative``
        @param replyTo optional value of Reply-To header
        @param objectId optional tracking identifier, to be included in the message-id for
                                recognizing replies. Suggested format for object-id is "resId-model",
                                e.g. "12345-crm.lead".
        @param subtype optional mime subtype for the text body (usually 'plain' or 'html'),
                                must match the format of the ``body`` parameter. Default is 'plain',
                                making the content part of the mail "text/plain".
        @param subtypeAlternative optional mime subtype of ``bodyAlternative`` (usually 'plain'
                                            or 'html'). Default is 'plain'.
        @param attachments list of (filename, filecontents) pairs, where filecontents is a string
                                containing the bytes of the attachment
        @param emailCc optional list of string values for CC header (to be joined with commas)
        @param emailBcc optional list of string values for BCC header (to be joined with commas)
        @param headers optional map of headers to set on the outgoing mail (may override the
                            other headers, including Subject, Reply-To, Message-Id, etc.)
        @returns the new RFC2822 email message
     */
    async buildEmail(emailFrom, emailTo, subject, body, opts: {
        emailCc?: any, emailBcc?: any, replyTo?: boolean,
        attachments?: any, messageId?: any, references?: any, objectId?: any, subtype?: string, headers?: any, bodyAlternative?: any, subtypeAlternative?: string
    } = {}) {
        // setOptions(opts, { subtype: 'plain', subtypeAlternative: 'plain' });
        let { emailCc, emailBcc, replyTo, attachments, messageId, references, objectId, subtype = 'plain', headers, bodyAlternative, subtypeAlternative = 'plain' } = opts;
        emailFrom = emailFrom || await this._getDefaultFromAddress();
        assert(emailFrom, ["You must either provide a sender address explicitly or configure ",
            "using the combination of `mail.catchall.domain` and `mail.default.from` ",
            "ICPs, in the server configuration file or with the ",
            "--email-from startup parameter."].join());

        headers = headers ?? {};         // need valid dict later
        emailCc = emailCc ?? [];
        emailBcc = emailBcc ?? [];
        body = body ?? '';

        const msg = {} //policy: email.policy.SMTP
        if (!messageId) {
            if (objectId) {
                messageId = tools.generateTrackingMessageId(objectId);
            }
            else {
                messageId = await makeMsgid();
            }
        }
        msg['messageId'] = messageId;
        if (references) {
            msg['references'] = references;
        }
        msg['subject'] = subject;
        msg['from'] = emailFrom;
        delete msg['replyTo'];
        msg['replyTo'] = replyTo || emailFrom;
        msg['to'] = emailTo.join(', ');
        if (bool(emailCc)) {
            msg['cc'] = emailCc.join(', ');
        }
        if (bool(emailBcc)) {
            msg['bcc'] = emailBcc.join(', ');
        }
        msg['date'] = Date.now();
        if (bool(headers)) {
            msg['headers'] = headers;
        }

        const emailBody = ustr(body);
        if (subtype === 'html' && !bodyAlternative) {
            msg['alternatives'] = [];
            msg['alternatives'].push({ content: html2Text(emailBody), contentType: 'plain', encoding: 'utf-8' });
            msg['alternatives'].push({ content: emailBody, contentType: subtype, encoding: 'utf-8' });
        }
        else if (bodyAlternative) {
            msg['alternatives'] = [];
            msg['alternatives'].push({ content: ustr(bodyAlternative), contentType: subtypeAlternative, encoding: 'utf-8' });
            msg['alternatives'].push({ content: emailBody, contentType: subtype, encoding: 'utf-8' });
        }
        else {
            msg['text'] = emailBody;
            msg['encoding'] = 'utf-8';
        }
        if (bool(attachments)) {
            for (const [fname, fcontent, mime] of attachments) {
                const [maintype, subtype] = mime && mime.includes('/') ? mime.split('/') : ['application', 'octet-stream'];
                msg['attachments'] = [];
                msg['attachments'].push({ content: fcontent, contentType: `${maintype}/${subtype}`, filename: fname });
            }
        }
        return msg;
    }

    /**
     * Compute the default bounce address.
 
        The default bounce address is used to set the envelop address if no
        envelop address is provided in the message.  It is formed by properly
        joining the parameters "mail.bounce.alias" and
        "mail.catchall.domain".
 
        If "mail.bounce.alias" is not set it defaults to "postmaster-verp".
 
        If "mail.catchall.domain" is not set, return null.
     */
    @api.model()
    async _getDefaultBounceAddress() {
        const getParam = (await this.env.items('ir.config.parameter').sudo()).getParam;
        const postmaster = await getParam('mail.bounce.alias', 'postmaster-verp');
        const domain = await getParam('mail.catchall.domain');
        if (postmaster && domain) {
            return f('%s@%s', postmaster, domain);
        }
    }

    /**
     * Compute the default from address.
        
        Used for the "header from" address when no other has been received.

        @returns str/null
            If the config parameter ``mail.default.from`` contains
            a full email address, return it.
            Otherwise, combines config parameters ``mail.default.from`` and
            ``mail.catchall.domain`` to generate a default sender address.

            If some of those parameters is not defined, it will default to the
            ``--email-from`` CLI/config parameter.
     */
    @api.model()
    async _getDefaultFromAddress() {
        const sudo = await this.env.items('ir.config.parameter').sudo();
        const getParam = sudo.getParam;
        const emailFrom = await getParam.call(sudo, "mail.default.from");
        if (emailFrom && emailFrom.includes('@')) {
            return emailFrom;
        }
        const domain = await getParam.call(sudo, "mail.catchall.domain");
        if (emailFrom && domain) {
            return f("%s@%s", emailFrom, domain);
        }
        return config.get("emailFrom");
    }

    /**
     * Prepare the SMTP information (from, to, message) before sending.
 
        @param message the email.message.Message to send, information like the
            Return-Path, the From, etc... will be used to find the smtp_from and to smtp_to
        @param smtpSession the opened SMTP session to use to authenticate the sender
        @returns [smtpFrom, smtpToList, message]
            smtpFrom: email to used during the authentication to the mail server
            smtpToList: list of email address which will receive the email
            message: the email.message.Message to send
     */
    async _prepareEmailMessage(message, smtpSession) {
        // Use the default bounce address **only if** no Return-Path was
        // provided by caller.  Caller may be using Variable Envelope Return
        // Path (Verp) to detect no-longer valid email addresses.
        const bounceAddress = message['returnPath'] || await this._getDefaultBounceAddress() || message['from'];
        let smtpFrom = message['from'] || bounceAddress;
        assert(smtpFrom, "The Return-Path or From header is required for any outbound email")

        const emailTo = message['to'],
            emailCc = message['cc'],
            emailBcc = message['bcc'];
        delete message['bcc'];

        // All recipient addresses must only contain ASCII characters
        const smtpToList = [];

        for (const base of [emailTo, emailCc, emailBcc])
            for (const address of extractRfc2822Addresses(base))
                if (address) smtpToList.push(address);

        assert(smtpToList.length, String(this.NO_VALID_RECIPIENT));

        const xForgeTo = message['xForgeTo'];
        if (xForgeTo) {
            // `To:` header forged, e.g. for posting on mail.channels, to avoid confusion
            delete message['xForgeTo'];
            delete message['to'];           // avoid multiple To: headers!
            message['to'] = xForgeTo;
        }

        // Try to not spoof the mail from headers
        const fromFilter = getattr(smtpSession, 'fromFilter', false);
        smtpFrom = getattr(smtpSession, 'smtpFrom', false) || smtpFrom;

        const notificationsEmail = emailNormalize(await this._getDefaultFromAddress());
        if (notificationsEmail && smtpFrom == notificationsEmail && message['from'] != notificationsEmail) {
            smtpFrom = encapsulateEmail(message['From'], notificationsEmail);
        }

        if (message['from'] != smtpFrom) {
            delete message['from'];
            message['from'] = smtpFrom;
        }

        // Check if it's still possible to put the bounce address as smtp_from
        if (this._matchFromFilter(bounceAddress, fromFilter)) {
            // Mail headers FROM will be spoofed to be able to receive bounce notifications
            // Because the mail server support the domain of the bounce address
            smtpFrom = bounceAddress;
        }

        // The email's "Envelope From" (Return-Path) must only contain ASCII characters.
        const smtpFromRfc2822 = extractRfc2822Addresses(smtpFrom);
        assert(smtpFromRfc2822.length, (
            `Malformed 'Return-Path' or 'From' address: ${smtpFrom}. \nIt should contain one valid plain ASCII email`));
        smtpFrom = smtpFromRfc2822.slice(-1)[0];

        return [smtpFrom, smtpToList, message];
    }

    /**
     * Sends an email directly (no queuing).
 
        No retries are done, the caller should handle MailDeliveryException in order to ensure that
        the mail is never lost.
 
        If the mailServerId is provided, sends using this mail server, ignoring other smtp_* arguments.
        If mailServerId is null and smtpServer is null, use the default mail server (highest priority).
        If mailServerId is null and smtp_server is not null, use the provided smtp_* arguments.
        If both mailServerId and smtpServer are null, look for an 'smtpServer' value in server config,
        and fails if not found.
 
        @param message the email.message.Message to send. The envelope sender will be extracted from the
                        ``Return-Path`` (if present), or will be set to the default bounce address.
                        The envelope recipients will be extracted from the combined list of ``To``,
                        ``CC`` and ``BCC`` headers.
        @param smtpSession optional pre-established SMTP session. When provided,
                             overrides `mailServerId` and all the `smtp_*` parameters.
                             Passing the matching `mailServerId` may yield better debugging/log
                             messages. The caller is in charge of disconnecting the session.
        @param mailServerId optional id of ir.mailServer to use for sending. overrides other smtp_* arguments.
        @param smtpServer optional hostname of SMTP server to use
        @param smtpEncryption optional TLS mode, one of 'none', 'starttls' or 'ssl' (see ir.mailServer fields for explanation)
        @param smtpPort optional SMTP port, if mailServerId is not passed
        @param smtpUser optional SMTP user, if mailServerId is not passed
        @param smtpPassword optional SMTP password to use, if mailServerId is not passed
        @param smtpSslCertificate filename of the SSL certificate used for authentication
        @param smtpSslPrivateKey filename of the SSL private key used for authentication
        @param smtpDebug optional SMTP debug flag, if mailServerId is not passed
        @returns the Message-ID of the message that was just sent, if successfully sent, otherwise raises
                 MailDeliveryException and logs root cause.
     */
    @api.model()
    async sendEmail(message, opts: {
        mailServerId?: any, smtpServer?: any, smtpPort?: any,
        smtpUser?: any, smtpPassword?: any, smtpEncryption?: any,
        smtpSslCertificate?: any, smtpSslPrivateKey?: any,
        smtpDebug?: boolean, smtpSession?: any
    } = {}) {
        const { mailServerId, smtpServer, smtpPort, smtpUser, smtpPassword, smtpEncryption,
            smtpSslCertificate, smtpSslPrivateKey, smtpDebug, smtpSession } = opts;
        let smtp = smtpSession;
        if (!smtp) {
            smtp = await this.connect({
                host: smtpServer, port: smtpPort, user: smtpUser, password: smtpPassword, encryption: smtpEncryption,
                smtpFrom: message['from'], sslCertificate: smtpSslCertificate, sslPrivateKey: smtpSslPrivateKey,
                smtpDebug, mailServerId
            });
        }
        let smtpFrom, smtpToList;
        [smtpFrom, smtpToList, message] = await this._prepareEmailMessage(message, smtp);

        // Do not actually send emails in testing mode!
        if (this._isTestMode()) {
            console.info("skip sending email in test mode");
            return message['messageId'];
        }
        let messageId;
        try {
            messageId = message['messageId'];

            smtp.sendMail(Object.assign(message, { from: smtpFrom, to: smtpToList.join(', ') }));

            // do not quit() a pre-established smtpSession
            if (!smtpSession) {
                smtp.close();
            }
        } catch (e) {
            if (e.code == 'SMTPServerDisconnected') {
                throw e;
            }
            const params = [ustr(smtpServer), e.constructor.name, ustr(e)];
            const msg = await this._t("Mail delivery failed via SMTP server '%s'.\n%s: %s", ...params);
            console.info(msg);
            throw new MailDeliveryException(await this._t("Mail Delivery Failed"), msg);
        }
        return messageId;
    }
    /**
     * Find the appropriate mail server for the given email address.
 
        Returns: Record<ir.mail_server>, email_from
        - Mail server to use to send the email (null if we use the verp-bin arguments)
        - Email FROM to use to send the email (in some case, it might be impossible
          to use the given email address directly if no mail server is configured for)
     * @param emailFrom 
     * @param mailServers 
     * @returns 
     */
    async _findMailServer(emailFrom, mailServers?: any) {
        const emailFromNormalized = emailNormalize(emailFrom),
            emailFromDomain = emailDomainExtract(emailFromNormalized),
            notificationsEmail = emailNormalize(await this._getDefaultFromAddress()),
            notificationsDomain = emailDomainExtract(notificationsEmail);

        if (mailServers == null) {
            mailServers = await (await this.sudo()).search([], { order: 'sequence' });
        }
        // 1. Try to find a mail server for the right mail from
        let mailServer = await mailServers.filtered(async (m) => emailNormalize(await m.fromFilter) == emailFromNormalized);
        if (bool(mailServer)) {
            return [mailServer[0], emailFrom];
        }

        mailServer = await mailServers.filtered(async (m) => emailDomainNormalize(await m.fromFilter) == emailFromDomain);
        if (bool(mailServer)) {
            return [mailServer[0], emailFrom];
        }

        // 2. Try to find a mail server for <notifications@domain.com>
        if (notificationsEmail) {
            mailServer = await mailServers.filtered(async (m) => emailNormalize(await m.fromFilter) == notificationsEmail);
            if (mailServer) {
                return [mailServer[0], notificationsEmail];
            }

            mailServer = await mailServers.filtered(async (m) => emailDomainNormalize(await m.fromFilter) == notificationsDomain);
            if (mailServer) {
                return [mailServer[0], notificationsEmail];
            }
        }

        // 3. Take the first mail server without "from_filter" because
        // nothing else has been found... Will spoof the FROM because
        // we have no other choices
        mailServer = await mailServers.filtered(async (m) => ! await m.fromFilter);
        if (bool(mailServer)) {
            return [mailServer[0], emailFrom];
        }

        // 4. Return the first mail server even if it was configured for another domain
        if (bool(mailServers)) {
            return [mailServers[0], emailFrom];
        }

        // 5: SMTP config in verp-bin arguments
        const fromFilter = await (await this.env.items('ir.config.parameter').sudo()).getParam(
            'mail.default.fromFilter', config.get('fromFilter'));

        if (this._matchFromFilter(emailFrom, fromFilter)) {
            return [null, emailFrom];
        }

        if (notificationsEmail && this._matchFromFilter(notificationsEmail, fromFilter)) {
            return [null, notificationsEmail];
        }

        return [null, emailFrom];
    }
    /**
     * Return true is the given email address match the "fromFilter" field.
 
        The from filter can be Falsy (always match),
        a domain name or an full email address.
     * @param emailFrom 
     * @param fromFilter 
     * @returns 
     */
    @api.model()
    _matchFromFilter(emailFrom, fromFilter) {
        if (!fromFilter) {
            return true;
        }

        const normalizedMailFrom = emailNormalize(emailFrom);
        if (fromFilter.includes('@')) {
            return emailNormalize(fromFilter) == normalizedMailFrom;
        }

        return emailDomainExtract(normalizedMailFrom) == emailDomainNormalize(fromFilter);
    }

    @api.onchange('smtpEncryption')
    async _onchangeEncryption() {
        const result = {};
        if (await this['smtpEncryption'] === 'ssl') {
            await this.set('smtpPort', 465);
            if (!('SMTP_SSL' in smtplib)) {
                result['warning'] = {
                    'title': await this._t('Warning'),
                    'message': await this._t('Your server does not seem to support SSL, you may want to try STARTTLS instead'),
                }
            }
        }
        else {
            await this.set('smtpPort', 25);
        }
        return result;
    }

    /**
     * Return true if we are running the tests, so we do not send real emails.
  
          Can be overridden in tests after mocking the SMTP lib to test in depth the
          outgoing mail server.
     * @returns 
     */
    _isTestMode() {
        return getattr(this.env, 'testing', false) || this.env.registry.inTestMode();
    }
}