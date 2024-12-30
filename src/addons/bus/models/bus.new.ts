import { ServerResponse } from "http";
import * as core from "../../../core";
import { api } from "../../../core";
import { setdefault } from "../../../core/api/func";
import { Fields } from "../../../core/fields";
import { Dict } from "../../../core/helper/collections";
import { WebRequest } from "../../../core/http";
import { MetaModel, Model } from "../../../core/models";
import { connectionInfoFor, dbConnect } from "../../../core/sql_db";
import { addDate, config, f } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";
import { doWithSync } from "../../../core/tools/func";
import { nextTick } from "process";
import createSubscriber from 'pg-listen';

export const TIMEOUT = 50;

function hashable(key): string {
  if (Array.isArray(key)) {
    key = Array.from(key).join(',');
  }
  return String(key);
}

function channelWithDb(dbname, channel) {
  if (channel instanceof Model) {
    return [dbname, channel._name, channel.id];
  }
  if (typeof (channel) === 'string') {
    return [dbname, channel];
  }
  return channel;
}

class Event {
  private _flag: boolean;
  private _cond: any;

  constructor() {
    this._cond = new Object();
    this._flag = false;
  }

  /**
   * Return true if and only if the internal flag is true.
   * @returns 
   */
  isSet() {
    return this._flag;
  }

  /**
   * Set the internal flag to true.

    All threads waiting for it to become true are awakened. Threads
    that call wait() once the flag is true will not block at all.
   */
  set() {
    // doWithSync(this._cond, () => {
      this._flag = true;
    //   this._cond.notifyAll();
    // });
  }

  /**
   * Reset the internal flag to false.

    Subsequently, threads calling wait() will block until set() is called to set the internal flag to true again.
   */
  clear() {
    doWithSync(this._cond, () => {
      this._flag = false;
    });
  }

  /**
   * Block until the internal flag is true.

    If the internal flag is true on entry, return immediately. Otherwise,
    block until another thread calls set() to set the flag to true, or until
    the optional timeout occurs.

    When the timeout argument is present and not None, it should be a
    floating point number specifying a timeout for the operation in seconds
    (or fractions thereof).

    This method returns the internal flag on exit, so it will always return
    True except if a timeout is given and the operation times out.
   * @param timeout 
   * @returns 
   */
  wait(timeout?: any) {
    doWithSync(this._cond, () => {
      let signaled = this._flag;
      if (!signaled) {
        signaled = this._cond.wait(timeout);
      }
      return signaled;
    });
  }

}

@MetaModel.define()
class ImBus extends Model {
  static _module = module;
  static _name = 'bus.bus';
  static _description = 'Communication Bus';

  static channel = Fields.Char('Channel');
  static message = Fields.Char('Message');

  @api.autovacuum()
  async _gcMessages() {
    const timeoutAgo = addDate(core._Datetime.now(), { seconds: TIMEOUT * 2 });
    const domain = [['createdAt', '<', timeoutAgo]];
    return (await (await this.sudo()).search(domain)).unlink();
  }

  @api.model()
  async _sendmany(notifications) {
    const channels = new Set();
    const values = [];
    for (const [target, notificationType, message] of notifications) {
      const channel = channelWithDb(this.env.cr.dbName, target);
      channels.add(channel);
      values.push({
        'channel': JSON.stringify(channel),
        'message': JSON.stringify({
          'type': notificationType,
          'payload': message,
        })
      })
    }
    await (await this.sudo()).create(values);
    if (channels.size) {
      // We have to wait until the notifications are commited in database.
      // When calling `NOTIFY imbus`, some concurrent threads will be
      // awakened and will fetch the notification in the bus table. If the
      // transaction is not commited yet, there will be nothing to fetch,
      // and the longpolling will return no notification.
      this.env.cr.postcommit.add(
        async () => {
          const cr = dbConnect(config.get('dbDialect')).cursor();
          await cr.execute(f("NOTIFY imbus, '%s'", String(Array.from(channels))));
          await cr.close();
        }
      );
    }
  }

  @api.model()
  async _sendone(channel, notificationType, message) {
    await this._sendmany([[channel, notificationType, message]]);
  }

  @api.model()
  async _poll(channels, last = 0, options = null) {
    let domain;
    // first poll return the notification in the 'buffer'
    if (last == 0) {
      const timeoutAgo = addDate(core._Datetime.now(), { seconds: TIMEOUT });
      domain = [['createdAt', '>', timeoutAgo]];
    }
    else {  // else returns the unread notifications
      domain = [['id', '>', last]];
    }
    channels = channels.map(c => channelWithDb(this.env.cr.dbName, c));
    domain.push(['channel', 'in', channels]);
    const notifications = await (await this.sudo()).searchRead(domain);
    // list of notification to return
    const result = [];
    for (const notif of notifications) {
      result.push({
        'id': notif['id'],
        'message': JSON.parse(notif['message']),
      })
    }
    return result;
  }
}


//----------------------------------------------------------
// Dispatcher
//----------------------------------------------------------
class ImDispatch {
  channels: {};
  started: boolean;

  constructor() {
    this.channels = {};
    this.started = false;
  }

  async poll(req: WebRequest, res: ServerResponse, dbname, channels: any[], last, options: {} = {}, timeout: number = null) {
    channels = channels.map(channel => channelWithDb(dbname, channel));
    if (timeout == null) {
      timeout = TIMEOUT;
    }
    // Dont hang ctrl-c for a poll request, we need to bypass private
    // attribute access because we dont know before starting the thread that
    // it will handle a longpolling request
    {
      const env = req && await req.getEnv();
      env.daemonic = true;
      // rename the thread to avoid tests waiting for a longpolling
      env.label = `core.longpolling.request.${env.ident}`
    }

    const registry = await core.registry(dbname);

    // immediatly returns if past notifications exist
    const cr = registry.cursor();
    const env = await api.Environment.new(cr, global.SUPERUSER_ID);
    let notifications = await env.items('bus.bus')._poll(channels, last, options);
    await cr.close();

    // immediatly returns in peek mode
    if (options['peek']) {
      return Dict.from({ notifications, channels });
    }

    // or wait for future ones
    if (!bool(notifications)) {
      if (!this.started) {
        // Lazy start of events listener
        await this.start();
      }

      const event = new Event();
      for (const channel of channels) {
        setdefault(this.channels, hashable(channel), new Set()).add(event);
      }
      try {
        event.wait(timeout);
        const cr = registry.cursor();
        const env = await api.Environment.new(cr, global.SUPERUSER_ID);
        notifications = await env.items('bus.bus')._poll(channels, last, options);
        await cr.close();
      } catch (e) {
        // timeout
        // pass
      }
      finally {
        // gc pointers to event
        for (const channel of channels) {
          const channelEvents: Set<any> = this.channels[hashable(channel)];
          if (bool(channelEvents) && channelEvents.has(event)) {
            channelEvents.delete(event);
          }
        }
      }
    }
    return notifications;
  }

  /**
   * Dispatch postgres notifications to the relevant polling threads/greenlets
   */
  async loop() {
    console.info("Bus.loop listen imbus on db postgres");
    /*
    const cr = dbConnect(config.get('dbDialect')).cursor();
    const conn = cr._obj;
    await cr.execute("listen imbus");
    await cr.commit();
    await cr.reset();
    
    while (! stopEvent.isSet()) {
      if (conn.connectionManager.isClosed) {
        // pass
      }
      else {
        // conn.connectionManager.poll();
        const channels = [];
        while conn.notifies:
            channels.extend(json.loads(conn.notifies.pop().payload))
        # dispatch to local threads/greenlets
        events = set()
        for channel in channels:
            events.update(self.channels.pop(hashable(channel), set()))
        for event in events:
            event.set()
      }
    }
    await cr.close();
    */
    
    const channel = 'imbus';
    const subscriber = createSubscriber(connectionInfoFor(config.get('dbDialect'), false)[1]);

    subscriber.notifications.on(channel, (payload) => {
      console.log('Received notification in ' + channel, payload);
    });

    subscriber.events.on('error', (error) => {
      console.error('Fatal database connection error:', error);
      // process.exit(1);
    });

    process.on('exit', () => {
      console.error("subscriber exit.");
      subscriber.close(); // promise
    });

    await subscriber.connect();
    await subscriber.listenTo(channel);
  }

  async run() {
    while (!stopEvent.isSet()) {
      try {
        stopEvent.set(); //
        await this.loop();
        // For debug
        break;
        // For debug
      } catch(e) {
        if (e.code == 'ECONNRESET') {
          console.error("Bus.loop error, sleep and retry:", e.message);
          break;
        }
        if (stopEvent.isSet()) {
          continue;
        }
        console.error("Bus.loop error, sleep and retry");
        setTimeout(() => {}, TIMEOUT);
      }
    }
  }

  async start() {
    await this.run();
    this.started = true;
    return this;
  }
}

const stopEvent = new Event();

export const dispatch = new ImDispatch();