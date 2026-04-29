const https = require('https');

const DEALERS = [
  { id: '1167', name: 'Autos Quito', slug: 'autos-quito' },
  { id: '1378', name: 'Sucursal', slug: 'autos-quito-sucursal' },
  { id: '1570', name: '10 de Agosto', slug: 'autos-quito-10-de-agosto' },
];

function getPage(url) {
  return new Promise((resolve) => {
    const doGet = (u, hops) => {
      if (hops > 8) return resolve({ ok: false, body: '', status: 0 });
      const req = https.get(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          'Accept': 'text/html,*/*;q=0.9',
          'Accept-Language': 'es-EC,es;q=0.9',
        },
        timeout: 25000,
      }, (res) => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          const loc = res.headers.location;
          res.resume();
          return doGet(loc.startsWith('http') ? loc : `https://ecuador.patiotuerca.com${loc}`, hops + 1);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', d => body += d);
        res.on('end', () => resolve({ ok: res.statusCode === 200, body, status: res.statusCode }));
      });
      req.on('error', () => resolve({ ok: false, body: '', status: -1 }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, body: '', status: -2 }); });
    };
    doGet(url, 0);
  });
}

function cleanHtml(raw) {
  return raw
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\n/g, '\n')
    .replace(/<!--\s*-->/g, '');
}

function extractFromPage(rawBody, dealer) {
  const vehicles = [];
  const seen = new Set();
  const html = cleanHtml(rawBody);

  const anchorRe = /href="(\/vehicle\/([^/]+)\/(\d+))"/g;
  const matches = [];
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    matches.push({ path: m[1], id: m[3], index: m.index });
  }

  for (let i = 0; i < matches.length; i++) {
    const { path, id, index } = matches[i];
    if (seen.has(id)) continue;
    seen.add(id);

    const end = matches[i + 1] ? matches[i + 1].index : index + 4000;
    const block = html.slice(index, Math.min(end, index + 4000));

    // Direct image URL (no proxy needed - images load fine directly)
    const imgM = block.match(/src="(https:\/\/images\.patiotuerca\.com\/[^"]+\.jpg)"/);

    // Title from h3
    const h3M = block.match(/<h3[^>]*>([^<]+)<\/h3>/);
    const altM = block.match(/alt="([^"]+)"/);
    const title = h3M ? h3M[1].trim() : (altM ? altM[1].trim() : '');

    // Year from <p class="text-sm font-bold...">2011</p>
    const yearTagM = block.match(/<p class="text-sm font-bold[^"]*">\s*(\d{4})\s*<\/p>/);
    const year = yearTagM ? yearTagM[1] : (block.match(/\b(19[89]\d|20[012]\d)\b/) || [])[1] || '';

    // KMs: <span>380,000 Kms</span>
    const kmsM = block.match(/<span>\s*([\d,.']+)\s*Kms\s*<\/span>/i);
    const kms = kmsM ? `${kmsM[1]} Kms` : '';

    // Price: <span class="text-lg font-semibold...">$10,990</span>
    const priceM = block.match(/<span class="text-lg font-semibold[^"]*">\s*\$([\d,.']+)\s*<\/span>/);
    const price = priceM ? `$${priceM[1]}` : '';

    vehicles.push({
      id,
      title: title || path.split('/').slice(-2,-1)[0].replace(/-/g,' '),
      price,
      year,
      kms,
      img: imgM ? imgM[1] : '',
      dealer: dealer.name,
      dealerId: dealer.id,
    });
  }

  return vehicles;
}

function hasNextPage(rawBody) {
  const html = cleanHtml(rawBody);
  // Look for a pagination link/button for "Siguiente" that is NOT disabled
  // Patiotuerca renders: <a ...>Siguiente</a> or <button ...>Siguiente</button>
  // When on last page it may be absent or have a disabled attribute
  const nextMatch = html.match(/Siguiente/i);
  if (!nextMatch) return false;
  // Check it's not inside a disabled element
  const idx = html.indexOf('Siguiente');
  const surrounding = html.slice(Math.max(0, idx - 200), idx + 50);
  if (/disabled/i.test(surrounding)) return false;
  if (/opacity-50|cursor-not-allowed|pointer-events-none/.test(surrounding)) return false;
  return true;
}

async function loadDealer(dealer) {
  const allVehicles = [];
  const seenIds = new Set();

  for (let page = 1; page <= 25; page++) {
    const url = `https://ecuador.patiotuerca.com/dealers-profile/${dealer.slug}/${dealer.id}?page=${page}`;
    const res = await getPage(url);

    if (!res.ok || !res.body) break;

    const found = extractFromPage(res.body, dealer);
    if (found.length === 0) break;

    let added = 0;
    for (const v of found) {
      if (v.id && !seenIds.has(v.id)) {
        seenIds.add(v.id);
        allVehicles.push(v);
        added++;
      }
    }

    // Stop if no new vehicles or no next page
    if (added === 0) break;
    if (!hasNextPage(res.body)) break;
  }

  return allVehicles;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const dealerId = req.query.dealer;
  const debug = req.query.debug === '1';
  const list = dealerId ? DEALERS.filter(d => d.id === dealerId) : DEALERS;

  try {
    if (debug) {
      const d = list[0];
      // Test pages 1 and 2 to verify pagination detection
      const r1 = await getPage(`https://ecuador.patiotuerca.com/dealers-profile/${d.slug}/${d.id}?page=1`);
      const r2 = await getPage(`https://ecuador.patiotuerca.com/dealers-profile/${d.slug}/${d.id}?page=2`);
      const html1 = cleanHtml(r1.body);
      const html2 = cleanHtml(r2.body);

      // Find "Siguiente" context in page 1
      const idx = html1.indexOf('Siguiente');
      const sigCtx = idx >= 0 ? html1.slice(Math.max(0, idx-300), idx+100) : 'NOT FOUND';

      // Count vehicles on each page
      const v1 = extractFromPage(r1.body, d);
      const v2 = extractFromPage(r2.body, d);

      return res.status(200).json({
        page1_vehicles: v1.length,
        page1_hasNext: hasNextPage(r1.body),
        page2_vehicles: v2.length,
        page2_hasNext: hasNextPage(r2.body),
        page2_ids: v2.map(v => v.id),
        siguienteContext: sigCtx,
      });
    }

    const results = await Promise.all(list.map(loadDealer));
    const vehicles = results.flat();
    res.status(200).json({ vehicles, total: vehicles.length, updated: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e.message), stack: String(e.stack).slice(0, 400) });
  }
};
