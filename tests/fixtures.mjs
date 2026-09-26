// Test fixtures modelled on the real AllZips sheet (same columns and value
// formats, including ZIPs stored without their leading zero, e.g. "6082").

export const BASE_ROWS = [
  { Zip: '63010', State: 'MO', 'Good to Go on Client': 'AMO', Timings: '|Mon - Fri 4pm till 7pm |CST|', 'Transfer to Preset': 'AMO Set' },
  { Zip: '91115', State: 'CA', 'Good to Go on Client': 'CA > Pasadena', Timings: '9:00 PM till 5:00 AM | PKST', 'Transfer to Preset': 'SunRun' },
  { Zip: '91115', State: 'CA', 'Good to Go on Client': 'Bath Expert', Timings: '| Mon - Thu till 6:59pm | Fri till 6:59pm | Sat till 5:59pm |EST|', 'Transfer to Preset': 'Bath Ex' },
  { Zip: '91115', State: 'CA', 'Good to Go on Client': 'Glendale Water & Power', Timings: '9:00 PM till 5:00 AM | PKST', 'Transfer to Preset': 'SunRun' },
  // exact duplicate row → should be collapsed
  { Zip: '91115', State: 'CA', 'Good to Go on Client': 'CA > Pasadena', Timings: '9:00 PM till 5:00 AM | PKST', 'Transfer to Preset': 'SunRun' },
  // leading zeros lost in the sheet
  { Zip: '6082', State: 'CT', 'Good to Go on Client': 'CT > Eversource', Timings: '9:00 PM till 5:00 AM | PKST', 'Transfer to Preset': 'SunRun' },
  { Zip: '501', State: 'NY', 'Good to Go on Client': 'NY Holtsville', Timings: '|Mon - Fri 9am till 5pm |EST|', 'Transfer to Preset': 'NY Set' },
  // missing fields → N/A
  { Zip: '44680', State: 'OH', 'Good to Go on Client': 'Bath Expert' },
  // hostile content must render as text
  { Zip: '11111', State: 'NY', 'Good to Go on Client': '<img src=x onerror="window.__xss=1">Evil', Timings: '<b>bold</b>', 'Transfer to Preset': '"><script>window.__xss=2</script>' },
  // ZipState-only row
  { ZipState: '02108', State: 'MA', 'Good to Go on Client': 'MA Client', Timings: 'Mon - Fri', 'Transfer to Preset': 'MA Set' },
  // malformed rows → skipped
  { Zip: '', State: 'TX', 'Good to Go on Client': 'Nobody' },
  { State: 'TX' },
  { Zip: 'abc', State: 'TX', 'Good to Go on Client': 'Bad' }
];

/** Pad the fixture to a realistic size (~25k rows like the production sheet). */
export function bigDataset(extra = 25000) {
  const rows = BASE_ROWS.slice();
  const clients = ['AMO', 'Bath Expert', 'SunRun Solar', 'TX > Bluebonnet Electric Coop', 'FL > Sumter Electric Coop'];
  for (let i = 0; i < extra; i++) {
    const zip = String(20000 + (i % 40000));
    if (zip === '63010' || zip === '44680' || zip === '91115' || zip === '11111') continue;
    rows.push({
      Zip: zip,
      State: 'TX',
      'Good to Go on Client': clients[i % clients.length],
      Timings: '|Mon - Fri 4pm till 7pm |CST|',
      'Transfer to Preset': 'Preset ' + (i % 17)
    });
  }
  return rows;
}

export function toCSV(rows) {
  const header = ['Zip', 'State', 'Good to Go on Client', 'Timings', 'Transfer to Preset', '', ''];
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [header.map(q).join(',')];
  for (const r of rows) {
    lines.push([r.Zip ?? r.ZipState, r.State, r['Good to Go on Client'], r.Timings, r['Transfer to Preset'], '', ''].map(q).join(','));
  }
  return lines.join('\n');
}
