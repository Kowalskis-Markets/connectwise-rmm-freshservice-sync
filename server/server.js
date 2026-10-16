'use strict';

const sync = require('./lib/sync');
const store = require('./lib/store');
const { describeError } = require('./lib/http');

const SCHEDULE_NAME = 'cw_poll';

function makeEnv(args) {
  return { request: $request, db: $db, iparams: args.iparams || {}, log: console };
}

const SCHEDULE_KEY = 'cw_schedule';

function pollSchedule(iparams) {
  const minutes = Math.max(5, Number(iparams.poll_interval_minutes) || 5);
  return {
    name: SCHEDULE_NAME,
    data: {},
    schedule_at: new Date(Date.now() + 60 * 1000).toISOString(),
    repeat: { time_unit: 'minutes', frequency: minutes }
  };
}

async function createSchedule(iparams) {
  const schedule = pollSchedule(iparams);
  try {
    await $schedule.create(schedule);
  } catch (err) {
    // Most likely a schedule left behind by an earlier install: update it instead.
    console.error(`Schedule create failed (${describeError(err)}); updating existing schedule`);
    await $schedule.update(schedule);
  }
  await $db.set(SCHEDULE_KEY, { frequency: schedule.repeat.frequency });
}

// Settings can change without a reinstall; apply a changed poll interval on the next poll.
async function applyIntervalChange(env) {
  const schedule = pollSchedule(env.iparams);
  const current = await store.get(env, SCHEDULE_KEY);
  if (current && current.frequency === schedule.repeat.frequency) return;
  await $schedule.update(schedule);
  await $db.set(SCHEDULE_KEY, { frequency: schedule.repeat.frequency });
  console.info(`Poll interval set to ${schedule.repeat.frequency} minutes`);
}

exports = {
  onAppInstallHandler: async function (args) {
    const env = makeEnv(args);
    try {
      await sync.checkConnections(env);
      // The Platform API has no ticket webhooks; polling is the sync mechanism. This URL is for
      // anything else that can post ticket events to the app.
      console.info(`External event URL: ${await generateTargetUrl()}`);
      await createSchedule(env.iparams);
      renderData();
    } catch (err) {
      console.error(`Install failed: ${describeError(err)}`);
      renderData({ message: describeError(err) });
    }
  },

  onAppUninstallHandler: async function () {
    try {
      await $schedule.delete({ name: SCHEDULE_NAME });
    } catch (err) {
      console.error(`Could not delete schedule: ${describeError(err)}`);
    }
    renderData();
  },

  onScheduledEventHandler: async function (args) {
    const env = makeEnv(args);
    try {
      await applyIntervalChange(env);
    } catch (err) {
      console.error(`Could not update poll interval: ${describeError(err)}`);
    }
    try {
      const result = await sync.poll(env);
      console.info(`ConnectWise poll: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`ConnectWise poll failed: ${describeError(err)}`);
    }
  },

  onExternalEventHandler: async function (args) {
    try {
      const result = await sync.handleWebhook(makeEnv(args), args.data, args.headers);
      console.info(`ConnectWise webhook: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`ConnectWise webhook failed: ${describeError(err)}`);
    }
  }
};
