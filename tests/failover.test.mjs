import test from 'node:test';
import assert from 'node:assert/strict';
import { PageServiceRouter, isTimeoutError } from '../src/shared/failover.js';
import {
  createProfile,
  normalizeSettings,
  publicSettings,
  translationSettingsChanged,
} from '../src/shared/config.js';
import { request, HttpError } from '../src/engine/protocols.js';
import { runJob } from '../src/engine/service.js';

const timeout = () => Object.assign(new Error('fixture timeout'), { code: 'REQUEST_TIMEOUT' });
function settings(extra = {}) {
  return normalizeSettings({
    profiles: ['a', 'b', 'c'].map((id) => ({
      ...createProfile(id),
      name: `中转站 ${id}`,
      baseUrl: 'https://example.test/v1',
      model: id,
      capabilities: { text: true, vision: id !== 'a', asr: false },
    })),
    roles: { text: 'a', input: '', subtitle: '', vision: 'b' },
    serviceFallback: { enabled: true, order: ['a', 'c', 'b'] },
    cache: false,
    ...extra,
  });
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function createRouter(config, behavior, url = () => 'https://page.test/one') {
  const calls = [],
    events = [];
  const router = new PageServiceRouter(
    async (kind, payload) => {
      if (kind === 'cancel') return;
      calls.push({ kind, ...payload });
      return behavior(payload, kind);
    },
    url,
    (event) => events.push(event),
  );
  router.configure(publicSettings(config));
  return { router, calls, events };
}
const translation = (jobId, extra = {}) => ({
  jobId,
  role: 'text',
  items: [{ id: 'p', text: jobId }],
  ...extra,
});

test('0.1.1 migration defaults off, names normalize and fallback order deduplicates by identity', () => {
  const old = settings();
  delete old.serviceFallback;
  const migrated = normalizeSettings(old);
  assert.equal(migrated.serviceFallback.enabled, false);
  assert.deepEqual(migrated.serviceFallback.order, ['a', 'b', 'c']);
  const custom = normalizeSettings({
    ...old,
    serviceFallback: { enabled: true, order: ['c', 'c', 'missing', 'a'] },
  });
  assert.deepEqual(custom.serviceFallback.order, ['c', 'a', 'b']);
  const renamed = structuredClone(custom);
  renamed.profiles[0].name = '  我的中转站  ';
  const next = normalizeSettings(renamed);
  assert.equal(next.profiles[0].name, '我的中转站');
  assert.equal(translationSettingsChanged(custom, next), false);
  next.serviceFallback.enabled = false;
  assert.equal(translationSettingsChanged(custom, next), true);
});

test('disabled fallback keeps the original request and retry policy', async () => {
  const { router, calls } = createRouter(settings({ serviceFallback: { enabled: false } }), () => {
    throw timeout();
  });
  await assert.rejects(router.run('translate', translation('off')), isTimeoutError);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].profileId, undefined);
  assert.equal(calls[0].stopOnTimeout, undefined);
});

test('ordered timeouts advance once and the successful provider sticks without changing defaults', async () => {
  const config = settings();
  const { router, calls } = createRouter(config, (payload) => {
    if (payload.profileId === 'a') throw timeout();
    if (payload.profileId === 'c') throw new HttpError('gateway timeout', 504);
    return payload.jobId;
  });
  assert.equal(await router.run('translate', translation('one')), 'one');
  assert.equal(await router.run('translate', translation('two')), 'two');
  assert.deepEqual(
    calls.map((call) => call.profileId),
    ['a', 'c', 'b', 'b'],
  );
  assert.ok(calls.every((call) => call.stopOnTimeout));
  assert.equal(router.status().profileId, 'b');
  assert.equal(config.roles.text, 'a');
  assert.equal(router.settings.roles.text, 'a');
});

test('auth, rate limit, invalid output, cancellation and ordinary network errors do not switch', async () => {
  for (const error of [
    new HttpError('auth', 401),
    new HttpError('limit', 429),
    new Error('invalid JSON'),
    new Error('Failed to fetch'),
    Object.assign(new Error('cancelled'), { code: 'CANCELLED' }),
  ]) {
    const { router, calls } = createRouter(settings(), () => {
      throw error;
    });
    await assert.rejects(router.run('translate', translation('error')), (value) => value === error);
    assert.deepEqual(
      calls.map((call) => call.profileId),
      ['a'],
    );
  }
});

test('disabled, unconfigured and capability-incompatible backups are skipped', async () => {
  const config = settings();
  config.profiles.push(
    { ...createProfile('disabled'), enabled: false, baseUrl: 'https://example.test', model: 'off' },
    { ...createProfile('empty'), baseUrl: '', model: '' },
    {
      ...createProfile('vision'),
      baseUrl: 'https://example.test',
      model: 'image',
      capabilities: { text: false, vision: true, asr: false },
    },
  );
  config.serviceFallback.order = ['disabled', 'empty', 'vision', 'c', 'b'];
  const { router, calls } = createRouter(config, (payload) => {
    if (payload.profileId === 'a') throw timeout();
    return 'done';
  });
  await router.run('translate', translation('eligibility'));
  assert.deepEqual(
    calls.map((call) => call.profileId),
    ['a', 'c'],
  );
});

test('vision uses its own capable chain and does not replace the text selection', async () => {
  const { router, calls } = createRouter(settings(), (payload) => {
    if (payload.profileId === 'b') throw new HttpError('request timeout', 408);
    return 'image';
  });
  await router.run('vision', { jobId: 'image', image: 'data:image/png;base64,AA==' });
  assert.deepEqual(
    calls.map((call) => call.profileId),
    ['b', 'c'],
  );
  assert.equal(router.status('vision').profileId, 'c');
  assert.equal(router.status('text').profileId, 'a');
});

test('an exhausted page does not repeatedly walk the failed list', async () => {
  const { router, calls } = createRouter(settings(), () => {
    throw timeout();
  });
  await assert.rejects(router.run('translate', translation('all')), /均已超时/);
  await assert.rejects(router.run('translate', translation('again')), /均已超时/);
  assert.deepEqual(
    calls.map((call) => call.profileId),
    ['a', 'c', 'b'],
  );
  router.reset();
  await assert.rejects(router.run('translate', translation('reset')), /均已超时/);
  assert.equal(calls.length, 6);
});

test('navigation and new documents restart at the primary provider', async () => {
  let url = 'https://page.test/one';
  const { router, calls } = createRouter(
    settings(),
    (payload) => {
      if (payload.profileId === 'a') throw timeout();
      return 'done';
    },
    () => url,
  );
  await router.run('translate', translation('one'));
  await router.run('translate', translation('same'));
  url = 'https://page.test/two';
  await router.run('translate', translation('two'));
  assert.deepEqual(
    calls.map((call) => call.profileId),
    ['a', 'c', 'c', 'a', 'c'],
  );
  const nextDocument = createRouter(
    settings(),
    (payload) => payload.profileId,
    () => url,
  );
  assert.equal(await nextDocument.router.run('translate', translation('new')), 'a');
});

test('names update without losing a live page selection, while service changes reset it', async () => {
  const config = settings();
  const { router } = createRouter(config, (payload) => {
    if (payload.profileId === 'a') throw timeout();
    return 'ok';
  });
  await router.run('translate', translation('first'));
  config.profiles[2].name = '新的服务别名';
  router.configure(publicSettings(config));
  assert.equal(router.status().profileId, 'c');
  router.configure(publicSettings(config), true);
  assert.equal(router.status().profileId, 'a');
});

test('concurrent initial translations share one failed probe and keep each job result', async () => {
  const failed = deferred();
  const { router, calls } = createRouter(settings(), (payload) => {
    if (payload.profileId === 'a') return failed.promise;
    return payload.jobId;
  });
  const jobs = ['one', 'two', 'three'].map((id) => router.run('translate', translation(id)));
  await Promise.resolve();
  assert.deepEqual(
    calls.map((call) => call.profileId),
    ['a'],
  );
  failed.reject(timeout());
  assert.deepEqual(await Promise.all(jobs), ['one', 'two', 'three']);
  assert.deepEqual(
    calls.map((call) => call.profileId),
    ['a', 'c', 'c', 'c'],
  );
});

test('a timeout from the sticky provider advances once and late successes cannot roll it back', async () => {
  const slowSuccess = deferred(),
    slowTimeout = deferred();
  const { router, calls } = createRouter(settings(), (payload) => {
    if (payload.profileId === 'a') throw timeout();
    if (payload.profileId === 'c' && payload.jobId === 'late') return slowSuccess.promise;
    if (payload.profileId === 'c' && payload.jobId === 'fails') return slowTimeout.promise;
    return payload.profileId;
  });
  await router.run('translate', translation('init'));
  const late = router.run('translate', translation('late'));
  const fails = router.run('translate', translation('fails'));
  slowTimeout.reject(timeout());
  assert.equal(await fails, 'b');
  slowSuccess.resolve('old-but-valid');
  assert.equal(await late, 'old-but-valid');
  assert.equal(router.status().profileId, 'b');
  assert.equal(await router.run('translate', translation('next')), 'b');
  assert.deepEqual(
    calls.map((call) => call.profileId),
    ['a', 'c', 'c', 'c', 'b', 'b'],
  );
});

test('a cancelled waiter exits promptly without submitting a fallback request', async () => {
  const held = deferred();
  const { router, calls } = createRouter(settings(), () => held.promise);
  const leader = router.run('translate', translation('leader'));
  const waiter = router.run('translate', translation('waiter'));
  const cancelledWaiter = assert.rejects(waiter, (error) => error.code === 'CANCELLED');
  router.cancel('waiter');
  await cancelledWaiter;
  held.resolve('done');
  assert.equal(await leader, 'done');
  assert.equal(calls.length, 1);
});

test('cancelled or navigated probes never start a later fallback', async () => {
  for (const action of ['cancel', 'navigate']) {
    const held = deferred();
    let url = 'https://page.test/one';
    const { router, calls } = createRouter(
      settings(),
      () => held.promise,
      () => url,
    );
    const job = router.run('translate', translation('pending'));
    const stopped = assert.rejects(job, (error) => error.code === 'CANCELLED');
    await Promise.resolve();
    if (action === 'cancel') router.cancel('pending');
    else {
      url = 'https://page.test/two';
      router.reset();
    }
    held.reject(timeout());
    await stopped;
    await Promise.resolve();
    assert.equal(calls.length, 1);
  }
});

test('comparison pins its model and generation never enters a translation fallback chain', async () => {
  const { router, calls } = createRouter(settings(), () => {
    throw timeout();
  });
  await assert.rejects(
    router.run('translate', translation('compare', { profileId: 'b', fallback: false })),
  );
  await assert.rejects(router.run('generate', { jobId: 'writing', profileId: 'b' }));
  assert.deepEqual(
    calls.map((call) => call.profileId),
    ['b', 'b'],
  );
  assert.ok(calls.every((call) => call.stopOnTimeout === undefined));
});

test('request timeout carries an exact error code and external cancellation is not a timeout', async () => {
  const fakeFetch = async (_url, options) =>
    new Promise((_resolve, reject) => {
      if (options.signal.aborted) reject(options.signal.reason);
      else
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        });
    });
  await assert.rejects(
    request('https://example.test', {}, { timeout: 0.005, fetchImpl: fakeFetch }),
    (error) => error.code === 'REQUEST_TIMEOUT',
  );
  const controller = new AbortController();
  controller.abort(Object.assign(new Error('cancel'), { code: 'CANCELLED' }));
  await assert.rejects(
    request('https://example.test', {}, { signal: controller.signal, fetchImpl: fakeFetch }),
    (error) => !isTimeoutError(error),
  );
});

test('engine preserves timeout status and skips same-provider retries when switching is enabled', async () => {
  const previousFetch = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async () => {
    count++;
    return new Response(JSON.stringify({ error: { message: 'fixture gateway timeout' } }), {
      status: 504,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const config = settings();
    config.profiles[0].retries = 5;
    await assert.rejects(
      runJob(
        config,
        {
          kind: 'translate',
          ...translation('engine'),
          stopOnTimeout: true,
        },
        'unit',
      ),
      (error) => error.status === 504 && isTimeoutError(error),
    );
    assert.equal(count, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
