import test from 'node:test';
import assert from 'node:assert/strict';
import { anchoredClock, createDeadline, elapsedSinceForeignStart, monotonicClock } from '../dist/index.js';

function fakeMono(start = 1000) {
  let now = start;
  return {
    clock: { now: () => now },
    advance: (ms) => {
      now += ms;
    },
  };
}

test('a wall-clock jump does not break a monotonic deadline (BLD-05)', (t) => {
  let wall = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => wall);
  const deadline = createDeadline(900);
  wall += 60 * 60 * 1000; // NTP or a user moves the clock forward by an hour
  assert.equal(deadline.expired(), false);
  assert.ok(deadline.remainingMs() > 800);
  wall -= 2 * 60 * 60 * 1000; // and back by two hours
  assert.equal(deadline.expired(), false);
});

test('anchoredClock advances with the monotonic clock only (BLD-05)', (t) => {
  let wall = 5_000;
  t.mock.method(Date, 'now', () => wall);
  const mono = fakeMono();
  const clock = anchoredClock(wall, mono.clock);
  wall += 3_600_000;
  mono.advance(25);
  assert.equal(clock.now(), 5_025);
});

test('createDeadline expires on the injected clock, including foreign elapsed time (BLD-05)', () => {
  const mono = fakeMono();
  const deadline = createDeadline(100, mono.clock, 40);
  assert.equal(deadline.remainingMs(), 60);
  mono.advance(59);
  assert.equal(deadline.expired(), false);
  mono.advance(1);
  assert.equal(deadline.expired(), true);
  assert.equal(deadline.remainingMs(), 0);
});

test('a foreign start time is translated once and conservatively (SSOT 17.2)', () => {
  assert.equal(elapsedSinceForeignStart(1_000, 1_250, 900), 250);
  assert.equal(elapsedSinceForeignStart(2_000, 1_000, 900), 0, 'a start in the future counts as no time elapsed');
  assert.equal(elapsedSinceForeignStart(Number.NaN, 1_000, 900), 900, 'an unreadable start spends the whole budget');
});

test('monotonicClock never goes backwards', () => {
  let previous = monotonicClock.now();
  for (let i = 0; i < 1000; i += 1) {
    const next = monotonicClock.now();
    assert.ok(next >= previous);
    previous = next;
  }
});
