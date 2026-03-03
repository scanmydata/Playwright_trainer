const fs = require('fs');
const path = require('path');

const dlDir = path.join(__dirname, '..', 'downloads');
if (!fs.existsSync(dlDir)) {
  console.error('downloads/ directory not found:', dlDir);
  process.exit(1);
}

// quarter last-months as used by the runner
const quarterLast = { 1: 3, 2: 7, 3: 10, 4: 12 };
// compute ranges from last-months
const ranges = [];
let prev = 0;
for (let q = 1; q <= 4; q++) {
  const end = quarterLast[q];
  const start = prev + 1;
  ranges.push({ q, start, end });
  prev = end;
}

const files = fs.readdirSync(dlDir).filter(f => f.endsWith('.pdf'));
const byYearQuarter = {}; // key: `${year}-Q${q}` -> array of {file, year, month}

for (const f of files) {
  const m = f.match(/monthly-(\d{4})-(\d{2})/);
  if (!m) continue; // only consider monthly-labeled files for this cleanup
  const year = Number(m[1]);
  const month = Number(m[2]);
  // find which special quarter range this month falls into
  const range = ranges.find(r => month >= r.start && month <= r.end);
  if (!range) continue;
  const key = `${year}-Q${range.q}`;
  byYearQuarter[key] = byYearQuarter[key] || [];
  byYearQuarter[key].push({ file: f, year, month, q: range.q });
}

if (Object.keys(byYearQuarter).length === 0) {
  console.log('No monthly files found for quarter cleanup.');
  process.exit(0);
}

const removedDir = path.join(dlDir, 'removed');
fs.mkdirSync(removedDir, { recursive: true });

const summary = [];
for (const [key, arr] of Object.entries(byYearQuarter)) {
  if (arr.length <= 1) continue;
  // determine keepMonth: the quarter's last month
  const qnum = arr[0].q;
  const keepMonth = quarterLast[qnum];
  let keeper = arr.find(x => x.month === keepMonth);
  if (!keeper) {
    // fallback: keep the file with the largest month
    keeper = arr.reduce((a, b) => a.month > b.month ? a : b);
  }
  const toRemove = arr.filter(x => x.file !== keeper.file);
  for (const r of toRemove) {
    const src = path.join(dlDir, r.file);
    const dst = path.join(removedDir, r.file);
    try {
      fs.renameSync(src, dst);
      console.log('Moved', r.file, '->', path.relative(process.cwd(), dst));
    } catch (e) {
      console.error('Failed to move', r.file, e.message);
    }
  }
  summary.push({ quarter: key, kept: keeper.file, moved: toRemove.map(x => x.file) });
}

console.log('\nCleanup summary:');
for (const s of summary) {
  console.log('-', s.quarter, 'kept:', s.kept, 'moved:', s.moved.join(', '));
}
if (summary.length === 0) console.log('No duplicate-quarter files found to clean.');
