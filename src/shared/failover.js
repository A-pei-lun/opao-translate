// Page-local selection only. No service choice is written to persistent settings.
export function isTimeoutError(error) {
  return error?.code === 'REQUEST_TIMEOUT' || error?.status === 408 || error?.status === 504;
}

function cancelled() {
  return Object.assign(new Error('已取消'), { code: 'CANCELLED' });
}
function waitFor(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export class PageServiceRouter {
  constructor(request, getUrl, onChange = () => {}) {
    this.request = request;
    this.getUrl = getUrl;
    this.onChange = onChange;
    this.states = new Map();
    this.tokens = new Set();
    this.url = getUrl();
  }
  configure(settings, forceReset = false) {
    const signature = JSON.stringify({
      profiles: settings.profiles.map(({ name, ...profile }) => profile),
      roles: settings.roles,
      fallback: settings.serviceFallback,
    });
    this.settings = settings;
    if (signature !== this.signature || forceReset) {
      this.signature = signature;
      this.reset();
    } else this.notify({ type: 'settings' });
  }
  notify(event) {
    this.onChange(event);
  }
  reset() {
    this.url = this.getUrl();
    this.states.clear();
    for (const token of this.tokens) {
      token.controller.abort(cancelled());
      this.request('cancel', { jobId: token.id }).catch(() => {});
    }
    this.notify({ type: 'reset' });
  }
  syncUrl() {
    if (this.url !== this.getUrl()) this.reset();
  }
  cancel(id) {
    for (const token of this.tokens) if (token.id === id) token.controller.abort(cancelled());
  }
  primary(role, explicitId) {
    return (
      explicitId || this.settings.roles[role] || (role === 'vision' ? '' : this.settings.roles.text)
    );
  }
  status(role = 'text') {
    this.syncUrl();
    const preferredId = this.primary(role);
    const state = this.states.get(`${role === 'vision' ? 'vision' : 'text'}:${preferredId}`);
    return {
      preferredId,
      profileId: state?.lastSuccess || preferredId,
      enabled: Boolean(this.settings.serviceFallback?.enabled),
      exhausted: Boolean(state?.exhausted),
    };
  }
  eligible(capability) {
    return this.settings.profiles.filter(
      (profile) =>
        profile.enabled &&
        profile.configured &&
        profile.protocol !== 'asr' &&
        profile.capabilities[capability],
    );
  }
  check(token) {
    this.syncUrl();
    if (token.controller.signal.aborted) throw token.controller.signal.reason;
  }
  advance(state, profileId, error) {
    // Only the first timeout for this selection advances the shared chain.
    if (state.currentId !== profileId) return;
    state.failed.add(profileId);
    state.confirmed = false;
    state.revision++;
    state.currentId = state.candidates.find((id) => !state.failed.has(id));
    if (!state.currentId) {
      state.exhausted = true;
      state.error = Object.assign(
        new Error('本页可尝试的服务均已超时，请刷新页面或手动更换服务后重试'),
        { code: 'REQUEST_TIMEOUT', status: error.status },
      );
    }
    this.notify({ type: 'timeout', from: profileId, to: state.currentId });
  }
  async probe(kind, payload, state, token) {
    while (!state.exhausted) {
      this.check(token);
      const profileId = state.currentId;
      try {
        const result = await this.request(kind, { ...payload, profileId, stopOnTimeout: true });
        this.check(token);
        state.confirmed = true;
        state.lastSuccess = profileId;
        this.notify({ type: 'ready', profileId, switched: profileId !== state.candidates[0] });
        return result;
      } catch (error) {
        this.check(token);
        if (!isTimeoutError(error)) throw error;
        this.advance(state, profileId, error);
      }
    }
    throw state.error;
  }
  async run(kind, payload) {
    this.syncUrl();
    if (
      !this.settings.serviceFallback?.enabled ||
      payload.fallback === false ||
      !['translate', 'vision'].includes(kind)
    )
      return this.request(kind, payload);
    const role = kind === 'vision' ? 'vision' : payload.role || 'text';
    const capability = role === 'vision' ? 'vision' : 'text';
    const initialId = this.primary(role, payload.profileId);
    const eligible = this.eligible(capability);
    // Keep the normal configuration error when the requested primary is unavailable.
    if (!eligible.some((profile) => profile.id === initialId)) return this.request(kind, payload);
    const key = `${capability}:${initialId}`;
    let state = this.states.get(key);
    if (!state) {
      const eligibleIds = new Set(eligible.map((profile) => profile.id));
      const candidates = [...new Set([initialId, ...this.settings.serviceFallback.order])].filter(
        (id) => eligibleIds.has(id),
      );
      state = {
        candidates,
        currentId: initialId,
        confirmed: false,
        failed: new Set(),
        revision: 0,
      };
      this.states.set(key, state);
    }
    const token = { id: payload.jobId || crypto.randomUUID(), controller: new AbortController() };
    payload = { ...payload, jobId: token.id };
    this.tokens.add(token);
    try {
      while (true) {
        this.check(token);
        if (state.probe) {
          await waitFor(
            state.probe.catch(() => {}),
            token.controller.signal,
          );
          continue;
        }
        if (state.exhausted) throw state.error;
        if (!state.confirmed) {
          const probe = Promise.resolve().then(() => this.probe(kind, payload, state, token));
          state.probe = probe;
          try {
            return await waitFor(probe, token.controller.signal);
          } finally {
            if (state.probe === probe) state.probe = null;
          }
        }
        const profileId = state.currentId;
        const revision = state.revision;
        try {
          const result = await this.request(kind, { ...payload, profileId, stopOnTimeout: true });
          this.check(token);
          // Late results can finish their own job but cannot move the page backwards.
          if (revision === state.revision) state.lastSuccess = profileId;
          return result;
        } catch (error) {
          this.check(token);
          if (!isTimeoutError(error)) throw error;
          this.advance(state, profileId, error);
        }
      }
    } finally {
      this.tokens.delete(token);
    }
  }
}
