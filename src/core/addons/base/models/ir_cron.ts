import assert from "assert";
import _ from "lodash";
import { Duration, Interval } from "luxon";
import { api } from "../../..";
import * as core from '../../../';
import { Environment } from "../../../api";
import { Fields, _Datetime } from "../../../fields";
import { OperationalError, UserError, ValueError } from "../../../helper/errors";
import { MetaModel, Model, _super } from "../../../models";
import { resetModulesState } from "../../../modules/loading";
import { loadInformationFromDescriptionFile } from "../../../modules/modules";
import { Cursor, dbConnect } from "../../../sql_db";
import { bool, config, isInstance, range } from "../../../tools";
import { addDate } from "../../../tools/date_utils";

const BASE_VERSION = loadInformationFromDescriptionFile('base')['version'];
const MAX_FAIL_TIME = Duration.fromObject({ hours: 5 }).valueOf(); // chosen with a fair roll of the dice

class BadVersion extends ValueError { }

class BadModuleState extends ValueError { }

const _durationTypes = {
  'days': (interval) => Duration.fromObject({ days: interval }),
  'hours': (interval) => Duration.fromObject({ hours: interval }),
  'weeks': (interval) => Duration.fromObject({ days: 7 * interval }),
  'months': (interval) => Duration.fromObject({ months: interval }),
  'minutes': (interval) => Duration.fromObject({ minutes: interval }),
}

@MetaModel.define()
export class IrCron extends Model {
  static _module = module;
  static _name = 'ir.cron';
  static _description = "Scheduled Actions";
  static _order = 'cronName';

  static irActionsServerId = Fields.Many2one('ir.actions.server', { string: 'Server action', delegate: true, ondelete: 'RESTRICT', required: true });
  static cronName = Fields.Char('Name', { related: 'irActionsServerId.label', store: true, readonly: false });
  static userId = Fields.Many2one('res.users', { string: 'Scheduler User', default: self => self.env.user(), required: true });
  static active = Fields.Boolean({ default: true });
  static intervalNumber = Fields.Integer({ default: 1, help: "Repeat every x." });
  static intervalType = Fields.Selection([['minutes', 'Minutes'],
  ['hours', 'Hours'],
  ['days', 'Days'],
  ['weeks', 'Weeks'],
  ['months', 'Months']], { string: 'Interval Unit', default: 'months' });
  static numbercall = Fields.Integer({ string: 'Number of Calls', default: 1, help: 'How many times the method is called,\na negative number indicates no limit.' });
  static doall = Fields.Boolean({ string: 'Repeat Missed', help: "Specify if missed occurrences should be executed when the server restarts." });
  static nextcall = Fields.Datetime({ string: 'Next Execution Date', required: true, default: () => _Datetime.now(), help: "Next planned execution date for this job." });
  static lastcall = Fields.Datetime({ string: 'Last Execution Date', help: "Previous time the cron ran successfully, provided to the job through the context on the `lastcall` key" });
  static priority = Fields.Integer({ default: 5, help: 'The priority of the job, as an integer: 0 means higher priority, 10 means lower priority.' });

  static async _processJobs(dbName) {
    try {
      const db = dbConnect(dbName);
      process.env.dbName = dbName;
      const cr = db.cursor();
      {
        await this._checkVersion(cr);
        const jobs = await this._getAllReadyJobs(cr);
        if (!jobs?.length) {
          return;
        }
        await this._checkModulesState(cr, jobs);
        for (const [jobId, jobName] of jobs.map(job => [job['id'], job['cronName']])) {
          let job;
          try {
            job = await this._acquireOneJob(cr, [jobId]);
          } catch (e) {
            await cr.rollback();
            console.debug("job #%s '%s' has been processed by another worker, skip. %s", jobId, jobName, e.message);
            continue;
          }
          if (!bool(job)) {
            console.debug("job #%s '%s' is processing by another worker, skip.", jobId, jobName);
            continue;
          }
          // console.debug("job %s '%s' acquired", jobId, jobName);
          // take into account overridings of _processJob() on that database
          const registry = await core.registry(dbName);
          await registry.models[this._name]._processJob(db, cr, job);
          console.debug("job #%s '%s' updated and released.", jobId, jobName);
        }
      }
      await cr.close();
    } catch (e) {
      if (isInstance(e, BadVersion)) {
        console.warn('Skipping database %s as its base version is not %s.', dbName, BASE_VERSION);
      }
      else if (isInstance(e, BadModuleState)) {
        console.warn('Skipping database %s because of modules to install/upgrade/remove.', dbName);
      }
      else {
        if (e.code === '42P01') {
          console.warn('Tried to poll an undefined table on database %s.', dbName);
        } else {
          throw e;
        }
      }
    } finally {
      if (process.env.dbname) {
        delete process.env.dbName;
      }
    }
  }

  /**
   * Execute a cron job and re-schedule a call for later.
   * @param db 
   * @param cr 
   * @param job 
   */
  static async _processJob(db, cronCr, job) {
    // Compute how many calls were missed and at what time we should
    // recall the cron next. In the example bellow, we fake a cron
    // with an interval of 30 (starting at 0) that was last executed
    // at 15 and that is executed again at 135.
    //
    //    0          60          120         180
    //  --|-----|-----|-----|-----|-----|-----|----> time
    //    1     2*    *     *     *  3  4
    //
    // 1: lastcall, the last time the cron was executed
    // 2: pastNextcall, the cron nextcall as seen from lastcall
    // *: missedCall, a total of 4 calls are missing
    // 3: now
    // 4: futureNextcall, the cron nextcall as seen from now

    const jobCr = await (this as any).pool.cursor();
    const lastcall = _Datetime.toDatetime(job['lastcall']);
    const duration: Duration = _durationTypes[job['intervalType']](job['intervalNumber']);
    const env = await Environment.new(jobCr, job['userId'], { 'lastcall': lastcall });
    const irCron = env.items(this._name);

    // Use the user's timezone to compare and compute datetimes,
    // otherwise unexpected results may appear. For instance, adding
    // 1 month in UTC to July 1st at midnight in GMT+2 gives July 30
    // instead of August 1st!
    const now = await _Datetime.contextTimestamp(irCron, new Date());
    const pastNextcall = await _Datetime.contextTimestamp(
      irCron, _Datetime.toDatetime(job['nextcall']) as Date);

    // Compute how many call were missed
    let missedCall: Date = pastNextcall;
    let missedCallCount = 0;
    while (missedCall <= now) {
      missedCall = addDate(missedCall, duration);
      missedCallCount += 1;
    }
    let futureNextcall = missedCall;

    // Compute how many time we should run the cron
    const effectiveCallCount = (
      !missedCallCount ? 1 :                              // run at least once
        !job['doall'] ? 1 :                                 // run once for all
          job['numbercall'] == -1 ? missedCallCount :         // run them all
            Math.min(missedCallCount, job['numbercall'])  // run maximum numbercall times
    );
    const callCountLeft = Math.max(job['numbercall'] - effectiveCallCount, -1);

    // The actual cron execution
    for (const call of range(effectiveCallCount)) {
      await irCron._callback(job['cronName'], job['irActionsServerId'], job['id']);
    }
    await jobCr.close();
    // Update the cron with the information computed above
    await cronCr.execute(`
        UPDATE "irCron"
        SET nextcall='%s',
            numbercall=%s,
            lastcall='%s',
            active=%s
        WHERE id=%s
    `, [
      futureNextcall.toISOString(),
      callCountLeft,
      now.toISOString(),
      job['active'] && bool(callCountLeft),
      job['id'],
    ]);

    await cronCr.execute(`
        DELETE FROM "irCronTrigger"
        WHERE "cronId" = %s
          AND "callAt" < (now() at time zone 'UTC')
    `, [job['id']]);

    await cronCr.commit();
  }

  static async _acquireOneJob(cr: Cursor, jobIds: any[]) {
    const query = `
      SELECT *
      FROM "irCron"
      WHERE "active" = true
        AND "numbercall" != 0
        AND ("nextcall" <= (now() at time zone 'UTC')
          OR EXISTS (
            SELECT "cronId"
            FROM "irCronTrigger"
            WHERE "callAt" <= (now() at time zone 'UTC')
              AND "cronId" = "irCron".id
          )
        )
        AND id in (%s)
      ORDER BY priority
      LIMIT 1 FOR NO KEY UPDATE SKIP LOCKED
    `;
    try {
      const res = await cr.execute(query, [jobIds.join(',')], false);
      return res[0];
    } catch (e) {
      // A serialization error can occur when another cron worker
      // commits the new `nextcall` value of a cron it just ran and
      // that commit occured just before this query. The error is
      // genuine and the job should be skipped in this cron worker.
      // raise except
      console.error("bad query: %s\nERROR: %s", query, e);
      throw e;
    }
  }

  /**
   * Ensure no module is installing or upgrading
   * @param cr 
   * @param jobs 
   * @returns 
   */
  static async _checkModulesState(cr: Cursor, jobs: any[]) {
    const res = await cr.execute(`
      SELECT COUNT(*)::int
      FROM "irModuleModule"
      WHERE "state" LIKE 'to %'
    `);
    const changes = res[0];
    if (!changes)
      return;

    if (!jobs?.length)
      throw new BadModuleState();

    const oldest = _.min(jobs.map(job => _Datetime.toDatetime(job['nextcall'])));
    if (Interval.fromDateTimes(new Date(), oldest).toDuration().valueOf() < MAX_FAIL_TIME) {
      throw new BadModuleState();
    }
    // the cron execution failed around MAX_FAIL_TIME * 60 times (1 failure per minute for 5h) in which case we assume that the crons are stuck because the db has zombie states and we force a call to resetModuleStates.
    await resetModulesState(cr.dbName);
  }

  /**
   * Return a list of all jobs that are ready to be executed
   * @param cr 
   * @returns 
   */
  static async _getAllReadyJobs(cr: Cursor) {
    const res = await cr.execute(`
      SELECT *
      FROM "irCron"
      WHERE "active" = true
        AND "numbercall" != 0
        AND ("nextcall" <= (now() at time zone 'UTC')
          OR id in (
            SELECT "cronId"
            FROM "irCronTrigger"
            WHERE "callAt" <= (now() at time zone 'UTC')
          )
        )
      ORDER BY "priority"
    `);
    return res;
  }
  /**
   * Ensure the code version matches the database version 
   * @param cr 
   */
  static async _checkVersion(cr: Cursor) {
    const res = await cr.execute(`
      SELECT "latestVersion" FROM "irModuleModule" WHERE "label"='base'
    `)
    const version = res[0]['latestVersion'];
    if (version == null)
      throw new BadModuleState();
    if (version !== BASE_VERSION)
      throw new BadVersion();
  }

  /**
   * Run the method associated to a given job. It takes care of logging
      and exception handling. Note that the user running the server action
      is the user calling this method.
   * @param cronName 
   * @param serverActionId 
   * @param jobId 
   */
  @api.model()
  async _callback(cronName, serverActionId, jobId) {
    try {
      let self = this;
      if (this.pool != await this.pool.checkSignaling()) {
        // the registry has changed, reload self in the new registry
        await this.env.reset();
        self = (await this.env.clone()).items(this._name);
      }
      // const logDepth = (None if _logger.isEnabledFor(logging.DEBUG) else 1)
      // core.netsvc.log(_logger, logging.DEBUG, 'cron.object.execute', (self._cr.dbname, self._uid, '*', cron_name, server_action_id), depth=log_depth)
      let startTime;
      // console.info('Starting job `%s`.', cronName);
      // if _logger.isEnabledFor(logging.DEBUG):
      //     start_time = time.time()
      await this.env.items('ir.actions.server').browse(serverActionId).run();
      console.info("job #%s '%s' done.", jobId, cronName);
      if (startTime) {//} && _logger.isEnabledFor(logging.DEBUG):
        const endTime = Date.now();
        console.debug('%s (cron "%s", server action %d with uid %d)', (endTime - startTime).toFixed(3), cronName, serverActionId, this.env.uid);
      }
      await this.pool.signalChanges();
    } catch (e) {
      await this.pool.resetChanges();
      console.error("Call from cron %s for server action #%s failed in Job #%s", cronName, serverActionId, jobId);
      await this._handleCallbackException(cronName, serverActionId, jobId, e);
    }
  }

  /**
   * Method called when an exception is raised by a job.

      Simply logs the exception and rollback the transaction.
   * @param cronName 
   * @param serverActionId 
   * @param jobId 
   * @param jobException 
   */
  @api.model()
  async _handleCallbackException(cronName, serverActionId, jobId, jobException) {
    await this._cr.rollback();
  }

  /**
   * Try to grab a dummy exclusive write-lock to the rows with the given ids,
        to make sure a following write() or unlink() will not block due
        to a process currently executing those cron tasks.

   * @param lockfk acquire a strong row lock which conflicts with
                      the lock aquired by foreign keys when they
                      reference this row.
   * @returns 
   */
  async _tryLock(lockfk = false) {
    const rowLevelLock = lockfk ? "UPDATE" : "NO KEY UPDATE"
    try {
      await this._cr.execute(`
                            SELECT id
                            FROM "${this.cls._table}"
                            WHERE id IN (${String(this.ids) || 'NULL'})
                            FOR ${rowLevelLock} NOWAIT
                          `);
    } catch (e) {
      if (isInstance(e, OperationalError)) {
        await this._cr.rollback()  // early rollback to allow translations to work for the user feedback
        throw new UserError(await this._t("Record cannot be modified right now: This cron task is currently being executed and may not be modified Please try again in a few minutes"));
      }
      else {
        throw e;
      }
    }
  }

  @api.model()
  async create(values) {
    values['usage'] = 'irCron';
    if (process.env['VERP_NOTIFY_CRON_CHANGES']) {
      this._cr.postcommit.add(this._notifydb);
    }
    return _super(IrCron, this).create(values);
  }

  async write(vals) {
    await this._tryLock();
    if (('nextcall' in vals || vals['active']) && process.env['VERP_NOTIFY_CRON_CHANGES']) {
      this._cr.postcommit.add(this._notifydb);
    }
    return _super(IrCron, this).write(vals);
  }

  async unlink() {
    await this._tryLock(true);
    return _super(IrCron, this).unlink();
  }

  @api.model()
  async defaultGet(fieldsList) {
    let self: any = this;
    // only 'code' state is supported for cron job so set it as default
    if (!this._context['defaultState']) {
      self = await self.withContext({ default_state: 'code' });
    }
    return _super(IrCron, self).defaultGet(fieldsList);
  }

  async methodDirectTrigger() {
    const self: any = this;
    await self.checkAccessRights('write');
    for (const cron of self) {
      const user = await cron.withUser(await cron.userId);
      const context = await user.withContext({ lastcall: await cron.lastcall });
      const server = await context.irActionsServerId;
      await server.run();
      await cron.set('lastcall', _Datetime.now());
    }
    return true;
  }

  /**
   * Wake up the cron workers
    The VERP_NOTIFY_CRON_CHANGES environment variable allows to force the notifydb on both
    irCron modification and on trigger creation (regardless of callAt)
   */
  async _notifydb() {
    const cr = dbConnect(config.get('dbDialect')).cursor();
    try {
      await cr.execute(`NOTIFY cronTrigger, ${this.env.cr.dbName}`);
    }
    finally {
      await cr.close();
    }
    console.debug("cron workers notified");
  }

  async tryWrite(values) {
    let err;
    try {
      // with this._cr.savepoint():
      await this._cr.execute(`
                SELECT id
                FROM "${this.cls._table}"
                WHERE id IN (%s)
                FOR NO KEY UPDATE NOWAIT
            `, [String(this.ids) || 'NULL'], false);
    } catch (e) {
      err = e;
      // except psycopg2.OperationalError:
      // pass
    }
    if (!err) {
      return _super(IrCron, this).write(values);
    }
    return false;
  }

  @api.model()
  async toggle(model, domain) {
    // Prevent deactivated cron jobs from being re-enabled through side effects on
    // neutralized databases.
    if (await (await this.env.items('ir.config.parameter').sudo()).getParam('database.isNeutralized')) {
      return true;
    }

    const active = bool(await this.env.items(model).searchCount(domain));
    return this.tryWrite({ 'active': active });
  }

  /**
   * Schedule a cron job to be executed soon independently of its
    ``nextcall`` field value.

    By default the cron is scheduled to be executed in the next batch but
    the optional `at` argument may be given to delay the execution later
    with a precision down to 1 minute.

    The method may be called with a datetime or an iterable of datetime.
    The actual implementation is in :meth:`~._trigger_list`, which is the
    recommended method for overrides.

   * @param at Optional[Union[datetime.datetime, list[datetime.datetime]]] at:
        When to execute the cron, at one or several moments in time instead
        of as soon as possible.
   */
  @api.model()
  async _trigger(at?: any) {
    let atList;
    if (at == null) {
      atList = [_Datetime.now()];
    }
    else if (isInstance(at, Date)) {
      atList = [at];
    }
    else {
      atList = Array.from(at);
      assert(atList.every(at => isInstance(at, Date)));
    }
    await this._triggerList(atList);
  }

  /**
   * Implementation of :meth:`~._trigger`.

   * @param atList list[datetime.datetime] Execute the cron later, at precise moments in time.
   * @returns 
   */
  @api.model()
  async _triggerList(atList) {
    this.ensureOne();
    const now = _Datetime.now();

    if (! await (await this.sudo()).active) {
      // skip triggers that would be ignored
      atList = atList.filter(at => at > now);
    }
    if (!bool(atList)) {
      return;
    }

    await (await this.env.items('ir.cron.trigger').sudo()).create(atList.map(at => { return { 'cronId': this.id, 'callAt': at } }));
    // if (isEnabledFor(logging.DEBUG)) 
    {
      const ats = atList.map(at => String(at)).join(', ');
      console.debug("will execute '%s' at %s", await (await this.sudo()).label, ats);
    }
    if (Math.min(...atList) <= now.valueOf() || process.env['VERP_NOTIFY_CRON_CHANGES']) {
      this._cr.postcommit.add(this._notifydb.bind(this));
    }
  }
}

@MetaModel.define()
class IrCronTrigger extends Model {
  static _module = module;
  static _name = 'ir.cron.trigger';
  static _description = 'Triggered actions';

  static cronId = Fields.Many2one("ir.cron", { index: true });
  static callAt = Fields.Datetime();

  @api.autovacuum()
  async _gcCronTriggers() {
    await (await this.search([['callAt', '<', addDate(_Datetime.now(), { weeks: -1 })]])).unlink();
  }
}