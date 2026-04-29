const https = require('https');

const DEALERS = [
  { id: '1167', name: 'Autos Quito', slug: 'autos-quito' },
  { id: '1378', name: 'Sucursal', slug: 'autos-quito-sucursal' },
  { id: '1570', name: '10 de Agosto', slug: 'autos-quito-10-de-agosto' },
];

function fetchUrl(url, headers = {}) {
  return new Promise((resolve) => {
    const doGet = (u, hops) => {
      if (hops > 8) return resolve({ ok: false, body: '', status: 0 });
      const req = https.get(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          'Accept': 'text/html,*/*',
          'Accept-Language': 'es-EC,es;q=0.9',
          'Referer': 'https://ecuador.patiotuerca.com/',
          ...headers,
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
        res.on('end', () => resolve({ ok: res.statusCode < 400, body, status: res.statusCode }));
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

function extractFromHtml(rawBody, dealer) {
  const vehicles = [];
  const seen = new Set();
  const html = cleanHtml(rawBody);
  const anchorRe = /href="(\/vehicle\/([^/]+)\/(\d+))"/g;
  const matches = [];
  let m;
  while ((m = anchorRe.exec(html)) !== null) matches.push({ path: m[1], id: m[3], index: m.index });

  for (let i = 0; i < matches.length; i++) {
    const { path, id, index } = matches[i];
    if (seen.has(id)) continue;
    seen.add(id);
    const end = Math.min((matches[i+1]?.index || index+4000), index+4000);
    const block = html.slice(index, end);
    const imgM   = block.match(/src="(https:\/\/images\.patiotuerca\.com\/[^"]+\.jpg)"/);
    const h3M    = block.match(/<h3[^>]*>([^<]+)<\/h3>/);
    const altM   = block.match(/alt="([^"]+)"/);
    const yearM  = block.match(/<p class="text-sm font-bold[^"]*">\s*(\d{4})\s*<\/p>/);
    const kmsM   = block.match(/<span>\s*([\d,.']+)\s*Kms\s*<\/span>/i);
    const priceM = block.match(/<span class="text-lg font-semibold[^"]*">\s*\$([\d,.']+)\s*<\/span>/);
    vehicles.push({
      id, price: priceM ? `$${priceM[1]}` : '',
      title: (h3M?.[1] || altM?.[1] || id).trim(),
      year: yearM?.[1] || (block.match(/\b(19[89]\d|20[012]\d)\b/)||[])[1] || '',
      kms: kmsM ? `${kmsM[1]} Kms` : '',
      img: imgM?.[1] || '',
      dealer: dealer.name, dealerId: dealer.id,
    });
  }
  return vehicles;
}

// Extract vehicles from RSC payload (used for vehiclePage=2+)
function extractFromRsc(rscBody, dealer) {
  const vehicles = [];
  const seen = new Set();
  const clean = rscBody.replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/<!--\s*-->/g, '');

  // RSC contains vehicle card HTML embedded in the payload
  // Look for vehicle anchor patterns
  const anchorRe = /href=\\"(\/vehicle\/([^/\\]+)\/(\d+))\\"/g;
  const anchorRe2 = /href="(\/vehicle\/([^/]+)\/(\d+))"/g;
  const matches = [];
  let m;

  while ((m = anchorRe.exec(rscBody)) !== null) matches.push({ path: m[1], id: m[3], index: m.index, raw: rscBody });
  while ((m = anchorRe2.exec(clean)) !== null) {
    if (!seen.has(m[3])) matches.push({ path: m[1], id: m[3], index: m.index, raw: clean });
  }

  for (const match of matches) {
    const { path, id, index, raw } = match;
    if (seen.has(id)) continue;
    seen.add(id);

    const block = raw.slice(index, Math.min(index + 2000, raw.length));
    const unescaped = block.replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/<!--\s*-->/g, '');

    const imgM   = unescaped.match(/src="(https:\/\/images\.patiotuerca\.com\/[^"]+\.jpg)"/);
    const h3M    = unescaped.match(/<h3[^>]*>([^<]+)<\/h3>/);
    const altM   = unescaped.match(/alt="([^"]+)"/);
    const yearM  = unescaped.match(/<p class="text-sm font-bold[^"]*">\s*(\d{4})\s*<\/p>/);
    const kmsM   = unescaped.match(/<span>\s*([\d,.']+)\s*Kms\s*<\/span>/i);
    const priceM = unescaped.match(/<span class="text-lg font-semibold[^"]*">\s*\$([\d,.']+)\s*<\/span>/);

    vehicles.push({
      id,
      title: (h3M?.[1] || altM?.[1] || id).trim(),
      price: priceM ? `$${priceM[1]}` : '',
      year: yearM?.[1] || (unescaped.match(/\b(19[89]\d|20[012]\d)\b/)||[])[1] || '',
      kms: kmsM ? `${kmsM[1]} Kms` : '',
      img: imgM?.[1] || '',
      dealer: dealer.name, dealerId: dealer.id,
    });
  }
  return vehicles;
}

async function loadDealer(dealer) {
  const allVehicles = [];
  const seenIds = new Set();

  const base = `https://ecuador.patiotuerca.com/dealers-profile/${dealer.slug}/${dealer.id}`;

  // Page 1 - regular HTML fetch
  const r1 = await fetchUrl(base);
  if (!r1.ok) return allVehicles;

  const html1 = cleanHtml(r1.body);
  const totalPagesM = html1.match(/P[aá]gina\s+\d+\s+de\s+(\d+)/i);
  const totalPages = totalPagesM ? parseInt(totalPagesM[1]) : 1;

  for (const v of extractFromHtml(r1.body, dealer)) {
    if (v.id && !seenIds.has(v.id)) { seenIds.add(v.id); allVehicles.push(v); }
  }

  // Pages 2+ using vehiclePage param with RSC header
  // The key insight from DevTools: ?vehiclePage=2&_rsc=wk6at with RSC:1 header
  for (let page = 2; page <= Math.min(totalPages, 25); page++) {
    const url = `${base}?vehiclePage=${page}&_rsc=1`;
    const r = await fetchUrl(url, {
      'RSC': '1',
      'Next-Router-State-Tree': encodeURIComponent(JSON.stringify(["",{"children":["__PAGE__",{}]},null,null,true])),
      'Next-Url': `/dealers-profile/${dealer.slug}/${dealer.id}`,
      'Accept': 'text/x-component',
    });

    if (!r.ok || !r.body) break;

    const found = extractFromRsc(r.body, dealer);
    if (found.length === 0) break;

    let added = 0;
    for (const v of found) {
      if (v.id && !seenIds.has(v.id)) { seenIds.add(v.id); allVehicles.push(v); added++; }
    }
    if (added === 0) break;
  }

  return allVehicles;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const dealerId = req.query.dealer;
  const debug    = req.query.debug === '1';
  const list     = dealerId ? DEALERS.filter(d => d.id === dealerId) : DEALERS;

  try {
    if (debug) {
      const d = list[0];
      const base = `https://ecuador.patiotuerca.com/dealers-profile/${d.slug}/${d.id}`;

      // Test vehiclePage=2 with RSC header
      const r2 = await fetchUrl(`${base}?vehiclePage=2&_rsc=1`, {
        'RSC': '1',
        'Next-Url': `/dealers-profile/${d.slug}/${d.id}`,
        'Accept': 'text/x-component',
      });

      const found2 = extractFromRsc(r2.body, d);
      const r1 = await fetchUrl(base);
      const found1 = extractFromHtml(r1.body, d);
      const html1 = cleanHtml(r1.body);
      const totalPagesM = html1.match(/P[aá]gina\s+\d+\s+de\s+(\d+)/i);

      return res.status(200).json({
        totalPages: totalPagesM ? parseInt(totalPagesM[1]) : 1,
        page1Count: found1.length,
        page1Ids: found1.map(v => v.id),
        page2Status: r2.status,
        page2Len: r2.body.length,
        page2Count: found2.length,
        page2Ids: found2.map(v => v.id),
        page2HasNewIds: found2.filter(v => !found1.find(v1 => v1.id === v.id)).length,
        page2Sample: found2.slice(0, 2),
        rscStart: r2.body.slice(0, 300),
      });
    }

    const results = await Promise.all(list.map(loadDealer));
    const vehicles = results.flat();
    res.status(200).json({ vehicles, total: vehicles.length, updated: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e.message), stack: String(e.stack).slice(0,400) });
  }
};
