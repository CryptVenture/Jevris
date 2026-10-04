// Loaded by the test preload. With JEVRIS_TEST_CLOCK_SHIFT_DAYS set (npm run test:future), the
// test process lives that many days ahead, consistently: Date, and the times fs reports for files.
// A stat result reads shifted; a time a test writes with utimes is shifted back first, so it reads
// back as written. The preload carries the variable into every child it starts, including one
// with an explicit env, so a child and its parent agree on the date. Not shifted: monotonic
// clocks (performance.now, process.hrtime), native code that reads the clock itself (SQLite's
// own date functions) and children that are not Node processes. Without the variable this module
// does nothing.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const days = Number(process.env.JEVRIS_TEST_CLOCK_SHIFT_DAYS ?? 0);
if (Number.isFinite(days) && days !== 0) {
  const offset = days * 86_400_000;
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  // A Proxy keeps Date's identity for instanceof and its prototype; only "now" moves. A test that
  // assigns its own Date.now (to fake a clock jump) is honoured, as it is on a real Date: the
  // assignment replaces the shifted clock for Date.now until the test puts the previous function
  // back. `new Date()` does not read Date.now, on a real Date or here.
  let nowOverride = null;
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length === 0 ? [realNow() + offset] : args, newTarget);
    },
    apply() {
      return new RealDate(realNow() + offset).toString();
    },
    get(target, key, receiver) {
      if (key === 'now') return nowOverride ?? (() => realNow() + offset);
      return Reflect.get(target, key, receiver);
    },
    set(target, key, value, receiver) {
      if (key === 'now') {
        nowOverride = typeof value === 'function' ? value : null;
        return true;
      }
      return Reflect.set(target, key, value, receiver);
    },
  });

  const shiftStats = (stats) => {
    if (stats === null || typeof stats !== 'object' || typeof stats.mtimeMs !== 'number') return stats;
    for (const key of ['atime', 'mtime', 'ctime', 'birthtime']) {
      const ms = stats[`${key}Ms`] + offset;
      Object.defineProperty(stats, `${key}Ms`, { value: ms, writable: true, enumerable: true, configurable: true });
      Object.defineProperty(stats, key, { value: new RealDate(ms), writable: true, enumerable: true, configurable: true });
    }
    return stats;
  };
  // utimes takes a Date, seconds as a number, or seconds as a numeric string.
  const unshift = (time) => {
    if (time instanceof RealDate) return (time.getTime() - offset) / 1000;
    if (typeof time === 'number') return time - offset / 1000;
    if (typeof time === 'string' && time.trim() !== '' && Number.isFinite(Number(time))) return Number(time) - offset / 1000;
    return time;
  };

  for (const name of ['statSync', 'lstatSync', 'fstatSync']) {
    const original = fs[name];
    fs[name] = function shiftedStat(...args) {
      return shiftStats(original.apply(this, args));
    };
  }
  for (const name of ['stat', 'lstat', 'fstat']) {
    const original = fs[name];
    fs[name] = function shiftedStat(...args) {
      const callback = args.at(-1);
      if (typeof callback !== 'function') return original.apply(this, args);
      return original.apply(this, [...args.slice(0, -1), (error, stats) => callback(error, error ? stats : shiftStats(stats))]);
    };
  }
  for (const name of ['stat', 'lstat']) {
    const original = fs.promises[name];
    fs.promises[name] = async function shiftedStat(...args) {
      return shiftStats(await original.apply(this, args));
    };
  }
  for (const holder of [fs, fs.promises]) {
    for (const name of ['utimes', 'lutimes', 'futimes', 'utimesSync', 'lutimesSync', 'futimesSync']) {
      const original = holder[name];
      if (typeof original !== 'function') continue;
      holder[name] = function shiftedTimes(target, atime, mtime, ...rest) {
        return original.call(this, target, unshift(atime), unshift(mtime), ...rest);
      };
    }
  }
  syncBuiltinESMExports();
}
