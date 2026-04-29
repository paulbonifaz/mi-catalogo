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

function extractFromListing(rawBody, dealer) {
  const vehicles = [];
  const seen = new Set();
  const html = cleanHtml(rawBody);

  // Split by vehicle anchor tags
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

    // Image - use the webp srcSet URL or jpg src
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

    // Proxy the image through our own API to avoid CORS issues on the frontend
    const imgUrl = imgM ? `/api/img?url=${encodeURIComponent(imgM[1])}` : '';

    vehicles.push({
      id,
      title: title || path.split('/').slice(-2,-1)[0].replace(/-/g,' '),
      price,
      year,
      kms,
      img: imgUrl,
      dealer: dealer.name,
      dealerId: dealer.id,
    });
  }

  return vehicles;
}

function getTotalPages(html) {
  // Look for "Página X de Y" pattern
  const clean = cleanHtml(html);
  const m = clean.match(/P[aá]gina\s+\d+\s+de\s+(\d+)/i);
  if (m) return parseInt(m[1]);
  // fallback: if "Siguiente" exists, there are more pages
  return clean.includes('Siguiente') ? 99 : 1;
}

async function loadDealer(dealer) {
  const allVehicles = [];
  const seenIds = new Set();

  // First fetch page 1 to determine total pages
  const firstUrl = `https://ecuador.patiotuerca.com/dealers-profile/${dealer.slug}/${dealer.id}?page=1`;
  const firstRes = await getPage(firstUrl);
  if (!firstRes.ok) return allVehicles;

  const totalPages = getTotalPages(firstRes.body);
  const pages = Math.min(totalPages, 20); // safety cap

  // Process page 1
  const firstFound = extractFromListing(firstRes.body, dealer);
  for (const v of firstFound) {
    if (v.id && !seenIds.has(v.id)) { seenIds.add(v.id); allVehicles.push(v); }
  }

  // Fetch remaining pages in parallel batches of 3
  for (let p = 2; p <= pages; p += 3) {
    const batch = [];
    for (let b = p; b < p + 3 && b <= pages; b++) {
      batch.push(getPage(`https://ecuador.patiotuerca.com/dealers-profile/${dealer.slug}/${dealer.id}?page=${b}`));
    }
    const results = await Promise.all(batch);
    let anyNew = false;
    for (const res of results) {
      if (!res.ok) continue;
      const found = extractFromListing(res.body, dealer);
      for (const v of found) {
        if (v.id && !seenIds.has(v.id)) { seenIds.add(v.id); allVehicles.push(v); anyNew = true; }
      }
    }
    if (!anyNew) break;
  }

  return allVehicles;
}

// Image proxy handler - avoids CORS issues loading Patiotuerca images from the browser
async function proxyImage(req, res) {
  const imgUrl = req.query.url;
  if (!imgUrl || !imgUrl.includes('patiotuerca.com')) {
    return res.status(400).end();
  }
  try {
    await new Promise((resolve, reject) => {
      https.get(imgUrl, {
        headers: { 'Referer': 'https://ecuador.patiotuerca.com/' }
      }, (imgRes) => {
        res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('Access-Control-Allow-Origin', '*');
        imgRes.pipe(res);
        imgRes.on('end', resolve);
      }).on('error', reject);
    });
  } catch(e) {
    res.status(502).end();
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Route: /api/img?url=... for image proxying
  if (req.url && req.url.includes('/img')) {
    return proxyImage(req, res);
  }

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const dealerId = req.query.dealer;
  const list = dealerId ? DEALERS.filter(d => d.id === dealerId) : DEALERS;

  try {
    const results = await Promise.all(list.map(loadDealer));
    const vehicles = results.flat();
    res.status(200).json({ vehicles, total: vehicles.length, updated: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
};
