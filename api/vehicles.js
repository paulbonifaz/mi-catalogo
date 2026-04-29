const https = require('https');

const DEALERS = [
  { id: '1167', name: 'Autos Quito', slug: 'autos-quito' },
  { id: '1378', name: 'Sucursal', slug: 'autos-quito-sucursal' },
  { id: '1570', name: '10 de Agosto', slug: 'autos-quito-10-de-agosto' },
];

function getPage(url) {
  return new Promise((resolve) => {
    const doGet = (u, hops) => {
      if (hops > 8) return resolve({ ok: false, body: '', status: 0, finalUrl: u });
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
        res.on('end', () => resolve({ ok: res.statusCode === 200, body, status: res.statusCode, finalUrl: u }));
      });
      req.on('error', () => resolve({ ok: false, body: '', status: -1, finalUrl: u }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, body: '', status: -2, finalUrl: u }); });
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

    const imgM  = block.match(/src="(https:\/\/images\.patiotuerca\.com\/[^"]+\.jpg)"/);
    const h3M   = block.match(/<h3[^>]*>([^<]+)<\/h3>/);
    const altM  = block.match(/alt="([^"]+)"/);
    const title = h3M ? h3M[1].trim() : (altM ? altM[1].trim() : '');
    const yearTagM = block.match(/<p class="text-sm font-bold[^"]*">\s*(\d{4})\s*<\/p>/);
    const year  = yearTagM ? yearTagM[1] : (block.match(/\b(19[89]\d|20[012]\d)\b/) || [])[1] || '';
    const kmsM  = block.match(/<span>\s*([\d,.']+)\s*Kms\s*<\/span>/i);
    const kms   = kmsM ? `${kmsM[1]} Kms` : '';
    const priceM = block.match(/<span class="text-lg font-semibold[^"]*">\s*\$([\d,.']+)\s*<\/span>/);
    const price = priceM ? `$${priceM[1]}` : '';

    vehicles.push({
      id, title: title || id, price, year, kms,
      img: imgM ? imgM[1] : '',
      dealer: dealer.name,
      dealerId: dealer.id,
    });
  }
  return vehicles;
}

function getTotalPages(rawBody) {
  const html = cleanHtml(rawBody);
  const m = html.match(/P[aá]gina\s+\d+\s+de\s+(\d+)/i);
  return m ? parseInt(m[1]) : 1;
}

async function loadDealer(dealer) {
  const allVehicles = [];
  const seenIds = new Set();

  // Get page 1 and find total pages
  const firstUrl = `https://ecuador.patiotuerca.com/dealers-profile/${dealer.slug}/${dealer.id}`;
  const r1 = await getPage(firstUrl);
  if (!r1.ok) return allVehicles;

  const totalPages = getTotalPages(r1.body);

  // Process page 1
  for (const v of extractFromPage(r1.body, dealer)) {
    if (v.id && !seenIds.has(v.id)) { seenIds.add(v.id); allVehicles.push(v); }
  }

  // Fetch pages 2..N - try different pagination params
  // From the HTML we know the page indicator exists. Try standard params.
  const paramVariants = ['page', 'pagina', 'p', 'pg'];
  let workingParam = 'page';

  // Test page 2 with each param variant to find which one works
  for (const param of paramVariants) {
    const testUrl = `https://ecuador.patiotuerca.com/dealers-profile/${dealer.slug}/${dealer.id}?${param}=2`;
    const testRes = await getPage(testUrl);
    if (testRes.ok) {
      const testVehicles = extractFromPage(testRes.body, dealer);
      const testIds = testVehicles.map(v => v.id);
      const firstIds = allVehicles.map(v => v.id);
      // Check if page 2 has different vehicles than page 1
      const hasDiff = testIds.some(id => !firstIds.includes(id));
      if (hasDiff) {
        workingParam = param;
        // Add page 2 vehicles
        for (const v of testVehicles) {
          if (v.id && !seenIds.has(v.id)) { seenIds.add(v.id); allVehicles.push(v); }
        }
        break;
      }
    }
  }

  // Now fetch remaining pages using the working param
  for (let page = 3; page <= Math.min(totalPages, 25); page++) {
    const url = `https://ecuador.patiotuerca.com/dealers-profile/${dealer.slug}/${dealer.id}?${workingParam}=${page}`;
    const res = await getPage(url);
    if (!res.ok) break;

    let added = 0;
    for (const v of extractFromPage(res.body, dealer)) {
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
  const debug = req.query.debug === '1';
  const list = dealerId ? DEALERS.filter(d => d.id === dealerId) : DEALERS;

  try {
    if (debug) {
      const d = list[0];
      const base = `https://ecuador.patiotuerca.com/dealers-profile/${d.slug}/${d.id}`;
      const r1 = await getPage(base);
      const v1 = extractFromPage(r1.body, d);
      const totalPages = getTotalPages(r1.body);

      // Test all param variants for page 2
      const paramTests = {};
      for (const param of ['page', 'pagina', 'p', 'pg']) {
        const r = await getPage(`${base}?${param}=2`);
        const vs = extractFromPage(r.body, d);
        const ids = vs.map(v => v.id);
        const different = ids.filter(id => !v1.map(v=>v.id).includes(id)).length;
        paramTests[param] = { status: r.status, count: vs.length, differentFromPage1: different, firstId: ids[0] };
      }

      return res.status(200).json({
        totalPages,
        page1Count: v1.length,
        page1FirstId: v1[0]?.id,
        paramTests,
      });
    }

    const results = await Promise.all(list.map(loadDealer));
    const vehicles = results.flat();
    res.status(200).json({ vehicles, total: vehicles.length, updated: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e.message), stack: String(e.stack).slice(0, 400) });
  }
};
