const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pdf = require('pdf-parse');

async function extractNormalized(buf) {
  try {
    const data = await pdf(buf);
    if (!data || !data.text) return '';
    return String(data.text)
      .replace(/\u00A0/g, ' ')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  } catch (e) {
    return '';
  }
}

(async function main(){
  const dlDir = path.join(__dirname, '..', 'downloads');
  const files = [];
  if (fs.existsSync(dlDir)) {
    for (const f of fs.readdirSync(dlDir)) {
      if (f.endsWith('.pdf')) files.push(path.join(dlDir, f));
    }
    const removed = path.join(dlDir, 'removed');
    if (fs.existsSync(removed)) {
      for (const f of fs.readdirSync(removed)) {
        if (f.endsWith('.pdf')) files.push(path.join(removed, f));
      }
    }
  }
  if (!files.length) { console.log('No PDF files found in downloads/'); return; }
  const groups = {}; // textHash -> array of file info
  for (const p of files) {
    try {
      const buf = fs.readFileSync(p);
      const txt = await extractNormalized(buf);
      const th = crypto.createHash('sha1').update(txt || '').digest('hex');
      const size = buf.length;
      groups[th] = groups[th] || [];
      groups[th].push({ path: p, size, textSample: (txt || '').slice(0,200) });
    } catch (e) {
      console.error('error reading', p, e.message);
    }
  }
  const keys = Object.keys(groups).sort((a,b) => groups[b].length - groups[a].length);
  for (const k of keys) {
    const arr = groups[k];
    console.log('\n=== TEXT HASH:', k, 'files:', arr.length, '===');
    for (const it of arr) {
      console.log('-', it.path, `${it.size} bytes`);
      console.log('  sample:', it.textSample.replace(/\n/g,' '));
    }
  }
})();
