export function visualPolicy({ reducedMotion = false, saveData = false, deviceMemory = 8, batteryLevel = 1, charging = true, forcedSaver = false } = {}) {
  const lowMemory = Number(deviceMemory) > 0 && Number(deviceMemory) <= 4;
  const lowBattery = !charging && Number(batteryLevel) <= 0.2;
  const saver = !!(forcedSaver || saveData || lowBattery);
  const reasons = [forcedSaver && 'manual', saveData && 'data saver', lowBattery && 'low battery', lowMemory && 'limited memory', reducedMotion && 'reduced motion'].filter(Boolean);
  return { ambient: !saver && !lowMemory && !reducedMotion, motion: !saver && !reducedMotion, saver, reasons };
}

export function observeVisualPolicy(onChange, forcedSaver = () => false, env = globalThis) {
  const nav = env.navigator || {};
  const motion = env.matchMedia ? env.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const connection = nav.connection || nav.mozConnection || nav.webkitConnection;
  let battery = null, stopped = false;
  const emit = () => onChange(visualPolicy({
    reducedMotion: !!motion?.matches,
    saveData: !!connection?.saveData,
    deviceMemory: nav.deviceMemory,
    batteryLevel: battery?.level,
    charging: battery?.charging ?? true,
    forcedSaver: forcedSaver(),
  }));
  const listen = (target, type, fn) => target?.addEventListener?.(type, fn);
  const unlisten = (target, type, fn) => target?.removeEventListener?.(type, fn);
  listen(motion, 'change', emit);
  listen(connection, 'change', emit);
  emit();
  Promise.resolve(nav.getBattery?.()).then(value => {
    if (!value || stopped) return;
    battery = value;
    listen(battery, 'levelchange', emit);
    listen(battery, 'chargingchange', emit);
    emit();
  }).catch(() => {});
  return { refresh: emit, stop() {
    stopped = true;
    unlisten(motion, 'change', emit);
    unlisten(connection, 'change', emit);
    unlisten(battery, 'levelchange', emit);
    unlisten(battery, 'chargingchange', emit);
  } };
}
