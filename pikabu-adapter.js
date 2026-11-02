// Pikabu SDK is available only inside a game or Studio page. Local previews keep working without it.
window.PikabuPlatform = (() => {
  let sdk = null;
  let onSaveError = () => {};
  let flushTimer = null;
  let flushInFlight = false;
  let dirty = false;
  let cloudBlocked = false;
  let levelTransitions = 0;
  let lastAdAt = 0;
  const sessionStartedAt = Date.now();

  function timeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Pikabu SDK timeout')), ms);
      Promise.resolve(promise).then(
        value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); }
      );
    });
  }

  function loadScript() {
    if (window.PkbSDK?.init) return Promise.resolve();
    return timeout(new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://games.pikabu.ru/sdk/sdk.js';
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Pikabu SDK script unavailable'));
      document.head.append(script);
    }), 8000);
  }

  function reportError(reason) {
    if (reason === 'REVISION_CONFLICT' || reason === 'QUOTA_EXCEEDED') cloudBlocked = true;
    onSaveError(reason);
  }

  async function init(options = {}) {
    onSaveError = options.onSaveError || (() => {});
    if (location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(location.hostname)) return false;
    try {
      await loadScript();
      if (typeof window.PkbSDK?.init !== 'function') throw new Error('Pikabu SDK init unavailable');
      const instance = await timeout(window.PkbSDK.init(), 10000);
      if (!instance?.storage || !['get', 'set', 'flush'].every(name => typeof instance.storage[name] === 'function')) {
        throw new Error('Pikabu cloud storage unavailable');
      }
      sdk = instance;
      if (typeof sdk.on === 'function') sdk.on('storageSaveError', reportError);
      return true;
    } catch (error) {
      console.warn('Pikabu SDK unavailable; using local preview', error);
      return false;
    }
  }

  function read(key) {
    if (sdk) {
      try {
        const value = sdk.storage.get(key);
        return value === undefined ? null : value;
      } catch (error) { console.warn('Pikabu cloud read failed', error); return null; }
    }
    try { return JSON.parse(localStorage.getItem(key)); }
    catch { return null; }
  }

  function scheduleFlush(delay = 5000) {
    if (!sdk || cloudBlocked) return;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { void flushNow(); }, delay);
  }

  function write(key, value) {
    let localSaved = false;
    let cloudQueued = false;
    try { localStorage.setItem(key, JSON.stringify(value)); localSaved = true; }
    catch (error) { console.warn('Local save failed', error); }
    if (sdk && !cloudBlocked) {
      try {
        sdk.storage.set(key, value);
        cloudQueued = true;
        dirty = true;
        scheduleFlush();
      } catch (error) {
        console.warn('Pikabu cloud write failed', error);
        reportError('UNKNOWN');
      }
    }
    return localSaved || cloudQueued;
  }

  async function flushNow() {
    clearTimeout(flushTimer);
    if (!sdk || cloudBlocked || !dirty || flushInFlight) return false;
    flushInFlight = true;
    dirty = false;
    try {
      const result = await sdk.storage.flush();
      if (!result?.success) {
        dirty = true;
        reportError(result?.reason || 'UNKNOWN');
        return false;
      }
      onSaveError(null);
      return true;
    } catch (error) {
      dirty = true;
      console.warn('Pikabu cloud flush failed', error);
      reportError('NETWORK_ERROR');
      return false;
    } finally {
      flushInFlight = false;
      if (dirty && !cloudBlocked) scheduleFlush(15000);
    }
  }

  function gameStarted() {
    try { sdk?.gameStarted?.(); }
    catch (error) { console.warn('Pikabu gameStarted failed', error); }
  }

  async function afterLevel(pause, resume) {
    levelTransitions++;
    const now = Date.now();
    if (!sdk || levelTransitions % 3 !== 0 || now - sessionStartedAt < 90000 || (lastAdAt && now - lastAdAt < 180000)) return false;
    const ad = sdk.ads?.fullscreen;
    if (!ad?.isSupported || typeof ad.canShow !== 'function' || typeof ad.show !== 'function') return false;
    try {
      if (!await ad.canShow()) return false;
      pause();
      try {
        const result = await ad.show();
        if (result?.rendered) lastAdAt = Date.now();
        else console.warn('Pikabu fullscreen unavailable', result?.reason);
        return !!result?.rendered;
      } finally { resume(); }
    } catch (error) {
      console.warn('Pikabu fullscreen failed', error);
      return false;
    }
  }

  return { init, read, write, flushNow, gameStarted, afterLevel, get cloudReady() { return !!sdk; } };
})();
