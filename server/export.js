// ---------------------------------------------------------------------------
// Exports of a stored test record: TCX / GPX per rider, Excel for the session.
// Samples in a record are compact rows: [seconds, power, hr, cadence].
// ---------------------------------------------------------------------------

import ExcelJS from 'exceljs';

const esc = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

const iso = (ms) => new Date(ms).toISOString();

export function fileSafe(name) {
  return String(name).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'export';
}

export function toTcx(record, rider) {
  const start = rider.startAt || record.startedAt || Date.now();
  const rows = rider.samples;
  const hrs = rows.map((r) => r[2]).filter((v) => v > 0);
  const total = rows.length ? rows.at(-1)[0] : 0;
  const points = rows
    .map(([t, power, hr, cad]) => {
      const parts = [`<Time>${iso(start + t * 1000)}</Time>`];
      if (hr > 0) parts.push(`<HeartRateBpm><Value>${hr}</Value></HeartRateBpm>`);
      if (cad > 0) parts.push(`<Cadence>${cad}</Cadence>`);
      if (power != null) parts.push(`<Extensions><ns3:TPX><ns3:Watts>${power}</ns3:Watts></ns3:TPX></Extensions>`);
      return `          <Trackpoint>${parts.join('')}</Trackpoint>`;
    })
    .join('\n');
  const hrBlock = hrs.length
    ? `<AverageHeartRateBpm><Value>${Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length)}</Value></AverageHeartRateBpm>
        <MaximumHeartRateBpm><Value>${Math.max(...hrs)}</Value></MaximumHeartRateBpm>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>${iso(start)}</Id>
      <Lap StartTime="${iso(start)}">
        <TotalTimeSeconds>${total}</TotalTimeSeconds>
        <DistanceMeters>0</DistanceMeters>
        <Calories>0</Calories>
        ${hrBlock}
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>
${points}
        </Track>
      </Lap>
      <Notes>${esc(`${record.name} - ${rider.name} (indoor, FTP test)`)}</Notes>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
`;
}

// Indoor trainer data has no position, so every point sits at 0,0. Power is
// written as <power> (read by Strava & co.), HR/cadence as Garmin extensions.
export function toGpx(record, rider) {
  const start = rider.startAt || record.startedAt || Date.now();
  const points = rider.samples
    .map(([t, power, hr, cad]) => {
      const ext = [];
      if (power != null) ext.push(`<power>${power}</power>`);
      const tpx = [];
      if (hr > 0) tpx.push(`<gpxtpx:hr>${hr}</gpxtpx:hr>`);
      if (cad > 0) tpx.push(`<gpxtpx:cad>${cad}</gpxtpx:cad>`);
      if (tpx.length) ext.push(`<gpxtpx:TrackPointExtension>${tpx.join('')}</gpxtpx:TrackPointExtension>`);
      return `      <trkpt lat="0" lon="0"><time>${iso(start + t * 1000)}</time>${ext.length ? `<extensions>${ext.join('')}</extensions>` : ''}</trkpt>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="FTP Tester" xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <metadata><name>${esc(`${record.name} - ${rider.name}`)}</name><time>${iso(start)}</time></metadata>
  <trk>
    <name>${esc(`${record.name} - ${rider.name}`)}</name>
    <type>VirtualRide</type>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
}

// --- Excel -------------------------------------------------------------------
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
const argb = (hex, tint = 0) => {
  // Blend towards white so zone colours stay readable behind dark text.
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * tint);
  const v = (mix((n >> 16) & 255) << 16) | (mix((n >> 8) & 255) << 8) | mix(n & 255);
  return `FF${v.toString(16).padStart(6, '0').toUpperCase()}`;
};
const fill = (hex, tint = 0.55) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: argb(hex, tint) } });
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF263241' } };

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.eachCell((c) => {
    c.fill = HEADER_FILL;
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
}

export async function toXlsx(record) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FTP Tester';
  wb.created = new Date();

  // ---- Summary: one row per rider ----------------------------------------
  const sum = wb.addWorksheet('Summary');
  sum.addRow([`${record.name}`]).font = { bold: true, size: 14 };
  sum.addRow([
    `Date: ${new Date(record.finishedAt || record.startedAt).toLocaleString('en-GB')}`,
    '',
    `Warm-up ${record.test.warmupMinutes} min · Effort ${record.test.effortMinutes} min @ ${record.test.effortPercentFtp}% FTP · Cool-down ${record.test.cooldownMinutes} min`,
  ]);
  sum.addRow([`FTP = average effort power × adjustment factor (${record.test.ftpFactor}) for a ${record.test.effortMinutes}-minute test`]);
  sum.addRow([]);
  const head = sum.addRow([
    'Rider', 'FTP before (W)', 'Effort avg power (W)', 'Adjustment factor', 'New FTP (W)', 'Δ FTP (W)', 'W/kg',
    'Normalized power (W)', 'Max power (W)', 'Avg HR (bpm)', 'Max HR (bpm)', 'LTHR (bpm)', 'LTHR source',
    'Effort completed', 'Duration',
  ]);
  styleHeader(head);
  head.height = 32;
  for (const r of record.riders) {
    const x = r.result;
    sum.addRow([
      r.name, x.ftpBefore, x.avgPower, x.adjustmentFactor, x.estimatedFtp,
      x.ftpBefore ? x.estimatedFtp - x.ftpBefore : null, x.wattsPerKg, x.normalizedPower, x.maxPower,
      x.avgHr || null, x.maxHr || null, x.lthr, x.lthr ? (x.lthrEstimated ? 'estimated from max HR' : 'measured') : '',
      x.effortCompletion, mmss(x.durationSec),
    ]);
  }
  sum.getColumn(14).numFmt = '0%';
  sum.getColumn(4).numFmt = '0.00';
  sum.columns.forEach((c, i) => (c.width = i === 0 ? 22 : 14));
  sum.getColumn(13).width = 22;

  // ---- Zones: 7 power zones + matching HR zones for every rider ----------
  const zs = wb.addWorksheet('Zones');
  zs.columns = [
    { width: 7 }, { width: 18 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 11 },
    { width: 13 }, { width: 11 }, { width: 13 }, { width: 11 },
  ];
  for (const r of record.riders) {
    const x = r.result;
    zs.addRow([`${r.name} — FTP ${x.estimatedFtp} W · LTHR ${x.lthr ?? '—'} bpm${x.lthrEstimated ? ' (est.)' : ''}`]).font = { bold: true, size: 12 };
    styleHeader(zs.addRow(['Zone', 'Name', '% FTP from', '% FTP to', 'Watts from', 'Watts to', 'HR from', 'HR to', 'Time in power zone', '% of time (power)', '% of time (HR)']));
    const first = zs.rowCount + 1;
    for (const z of x.zones) {
      const row = zs.addRow([
        `Z${z.zone}`, z.name, z.pctMin, z.pctMax, z.lowW, z.highW, z.lowBpm, z.highBpm,
        mmss(z.powerSeconds), z.powerPct, z.hrPct,
      ]);
      for (let c = 1; c <= 8; c++) row.getCell(c).fill = fill(z.color);
      row.getCell(1).font = { bold: true };
      [3, 4, 10, 11].forEach((c) => (row.getCell(c).numFmt = '0%'));
    }
    const last = zs.rowCount;
    // Colour scale on time spent per zone so the distribution is visible at a glance.
    for (const col of ['J', 'K']) {
      zs.addConditionalFormatting({
        ref: `${col}${first}:${col}${last}`,
        rules: [{
          type: 'colorScale',
          cfvo: [{ type: 'num', value: 0 }, { type: 'max' }],
          color: [{ argb: 'FFFFFFFF' }, { argb: 'FF29ABE2' }],
        }],
      });
    }
    zs.addRow([]);
  }

  // ---- Raw data: one sheet per rider --------------------------------------
  const used = new Set(['Summary', 'Zones']);
  for (const r of record.riders) {
    let name = r.name.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || 'Rider';
    for (let i = 2; used.has(name.toLowerCase()) || used.has(name); i++) name = `${name.slice(0, 26)} ${i}`;
    used.add(name);
    const ws = wb.addWorksheet(name);
    styleHeader(ws.addRow(['Time (s)', 'Phase', 'Power (W)', 'Heart rate (bpm)', 'Cadence (rpm)']));
    const { warmupSec, effortSec } = record.test;
    for (const [t, p, h, c] of r.samples) {
      ws.addRow([t, t < warmupSec ? 'warm-up' : t < warmupSec + effortSec ? 'effort' : 'cool-down', p, h, c]);
    }
    ws.columns.forEach((c) => (c.width = 16));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  return wb.xlsx.writeBuffer();
}
