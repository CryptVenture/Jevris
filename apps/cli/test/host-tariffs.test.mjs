// Serving hosts R56 (design 8): doctor's hostTariffs line counts the registry's servings by host and
// by tariff basis, and names the sources with the day each was read. Pure function: no home.
import test from 'node:test';
import assert from 'node:assert/strict';

const { hostTariffsDoctorLine } = await import('../dist/host-tariffs.js');
const { doctorLineSeverity } = await import('../dist/doctor-severity.js');

const serving = (host, tariffBasis, sourceIds = ['MODELSDEV-1']) => ({ host, provider: 'moonshot', modelId: 'kimi-k3', hostModelId: 'moonshotai/kimi-k3', tariff: null, tariffBasis, sourceIds });

test('the hostTariffs line: counts per host and basis, the sources with their day, and advice only where a tariff is not the host\'s', () => {
  const sources = { 'MODELSDEV-1': { fetchedOn: '2026-09-28' }, 'KGW-1': { fetchedOn: '2026-09-27T00:00:00Z' } };
  const line = hostTariffsDoctorLine([serving('openrouter', 'host'), serving('openrouter', 'free-tier'), serving('kilo', 'host', ['KGW-1']), serving('nvidia', 'unknown', ['ADMIN-7'])], sources);
  assert.equal(line, "hostTariffs: 4 servings on 3 hosts (kilo 1, nvidia 1, openrouter 2): 2 at the host's tariff, 1 free-tier, 1 unknown (routes through a free-tier or unknown tariff give advice only); from ADMIN-7, KGW-1 (2026-09-27), MODELSDEV-1 (2026-09-28)");
  assert.equal(hostTariffsDoctorLine([serving('kilo', 'host')], sources), "hostTariffs: 1 serving on 1 host (kilo 1): 1 at the host's tariff, 0 free-tier, 0 unknown; from MODELSDEV-1 (2026-09-28)");
  assert.equal(hostTariffsDoctorLine(undefined, sources), 'hostTariffs: none in the model registry routing reads, so a route through a serving host gives advice only');
  assert.equal(hostTariffsDoctorLine([], sources), hostTariffsDoctorLine(undefined, sources));
  assert.equal(doctorLineSeverity(line), 'info');
  // A source id is shown only as an own key: an inherited name is never read as a source.
  assert.match(hostTariffsDoctorLine([serving('kilo', 'host', ['constructor'])], sources), /from constructor$/);
});
