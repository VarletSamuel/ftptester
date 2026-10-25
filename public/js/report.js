// ---------------------------------------------------------------------------
// Test report: per rider, the FTP outcome, the adjustment factor used for the
// chosen test duration, and the 7 power zones with matching heart-rate zones,
// colour-coded, plus downloads (TCX / GPX per rider, Excel for the whole test).
// ---------------------------------------------------------------------------
import { api } from './api.js';
import { hexA } from './charts.js';
import { fmtDuration } from './metrics.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v) => `${Math.round(v * 100)}%`;

/**
 * @param record { id, name, finishedAt?, test, riders:[{userId,name,result}] }
 */
export function renderReport(record) {
  const t = record.test;
  const riders = record.riders.filter((r) => r.result);
  const when = record.finishedAt ? new Date(record.finishedAt).toLocaleString() : '';
  return `
    <div class="report">
      <div class="report-head">
        <div>
          <h2>${esc(record.name)}</h2>
          <p class="hint">${when ? `${when} · ` : ''}Warm-up ${t.warmupMinutes} min · Effort ${t.effortMinutes} min @ ${t.effortPercentFtp}% FTP · Cool-down ${t.cooldownMinutes} min</p>
          <p class="factor-note">FTP = average effort power × <strong>${t.ftpFactor}</strong> <span class="hint">(adjustment factor for a ${t.effortMinutes}-minute test)</span></p>
        </div>
        <a class="btn primary" href="${api.excelUrl(record.id)}" download>⬇ Excel (all riders)</a>
      </div>
      ${riders.length ? riders.map((r) => riderReport(record, r)).join('') : '<p class="hint">No rider data was captured.</p>'}
    </div>`;
}

function riderReport(record, r) {
  const x = r.result;
  const delta = x.ftpBefore ? x.estimatedFtp - x.ftpBefore : null;
  const maxShare = Math.max(0.0001, ...x.zones.map((z) => Math.max(z.powerPct, z.hrPct)));
  const hasHr = x.zones.some((z) => z.lowBpm !== null);
  const rows = x.zones
    .map((z) => {
      const range = (lo, hi, unit) => (lo === null ? '—' : hi === null ? `${lo}+ ${unit}` : `${lo}–${hi} ${unit}`);
      const share = (v, s) =>
        `<div class="share"><i style="width:${(v / maxShare) * 100}%;background:${z.color}"></i><span>${fmtDuration(s)} · ${pct(v)}</span></div>`;
      return `<tr style="--z:${z.color}">
        <td class="zcell" style="background:${hexA(z.color, 0.28)};border-left:6px solid ${z.color}"><strong>Z${z.zone}</strong> ${esc(z.name)}</td>
        <td>${z.pctMax === null ? `>${pct(z.pctMin)}` : `${pct(z.pctMin)}–${pct(z.pctMax)}`}</td>
        <td class="zrange" style="background:${hexA(z.color, 0.18)}">${range(z.lowW, z.highW, 'W')}</td>
        <td class="zrange" style="background:${hexA(z.color, 0.18)}">${hasHr ? range(z.lowBpm, z.highBpm, 'bpm') : '—'}</td>
        <td>${share(z.powerPct, z.powerSeconds)}</td>
        <td>${hasHr ? share(z.hrPct, z.hrSeconds) : '—'}</td>
      </tr>`;
    })
    .join('');

  const fact = (label, value) => `<div class="fact"><span>${label}</span><strong>${value}</strong></div>`;
  return `
    <section class="report-rider">
      <div class="rr-head">
        <h3>${esc(r.name)}</h3>
        <div class="rr-ftp"><span class="big">${x.estimatedFtp} W</span>
          ${delta !== null ? `<span class="delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : ''}${delta} W vs ${x.ftpBefore} W</span>` : ''}
        </div>
        <div class="btn-row">
          <a class="btn mini" href="${api.exportUrl(record.id, `${r.userId}.tcx`)}" download>TCX</a>
          <a class="btn mini" href="${api.exportUrl(record.id, `${r.userId}.gpx`)}" download>GPX</a>
        </div>
      </div>
      <div class="facts">
        ${fact('Effort avg power', `${x.avgPower} W`)}
        ${fact('Adjustment factor', `× ${x.adjustmentFactor}`)}
        ${fact('Effort length', `${x.effortMinutes} min (${pct(x.effortCompletion)} done)`)}
        ${fact('Normalized power', `${x.normalizedPower} W`)}
        ${fact('W/kg', x.wattsPerKg ?? '—')}
        ${fact('Avg / max HR', x.avgHr ? `${x.avgHr} / ${x.maxHr} bpm` : '—')}
        ${fact('LTHR', x.lthr ? `${x.lthr} bpm <small>${x.lthrEstimated ? 'estimated from max HR' : 'measured'}</small>` : '—')}
      </div>
      <div class="table-wrap">
      <table class="zones-table">
        <thead><tr><th>Power zone</th><th>% of FTP</th><th>Power</th><th>Heart rate</th><th>Time (by power)</th><th>Time (by HR)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>`;
}
