const https = require('https');

const DEALERS = [
  { id: '1167', name: 'Autos Quito', slug: 'autos-quito' },
  { id: '1378', name: 'Sucursal', slug: 'autos-quito-sucursal' },
  { id: '1570', name: '10 de Agosto', slug: 'autos-quito-10-de-agosto' },
];

const SCRAPER_API_KEY = process.env.SCRAPERAPI_KEY || '';

function fetchUrl(targetUrl) {
  return new Promise((resolve) => {
    const proxyUrl = `https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}&render=true&premium=true&country_code=ec`;

    const req = https.get(proxyUrl, { timeout: 60000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => body += d);
      res.on('end', () => resolve({ ok: res.statusCode < 400, body, status: res.statusCode }));
    });
    req.on('error', (e) => resolve({ ok: false, body: '', status: -1, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, body: '', status: -2 }); });
  });
}

function cleanHtml(raw) {
  return raw
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\n/g, '\n')
    .replace(/<!--\s*-->/g, '');
}

// Robust extraction independent of CSS class names.
function extractFromHtml(rawBody, dealer) {
  const vehicles = [];
  const seen = new Set();
  const html = cleanHtml(rawBody);

  const anchorRe = /href="(\/vehicle\/([^/"]+)\/(\d+))"/g;
  const matches = [];
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    matches.push({ path: m[1], id: m[3], index: m.index });
  }

  for (let i = 0; i < matches.length; i++) {
    const { path, id, index } = matches[i];
    if (seen.has(id)) continue;
    seen.add(id);

    const end = matches[i + 1] ? matches[i + 1].index : index + 3000;
    const block = html.slice(index, Math.min(end, index + 3000));

    const imgM = block.match(/(https:\/\/images\.patiotuerca\.com\/[^"'\s)]+\.(?:jpe?g|png|webp))/i);

    const h3M = block.match(/<h3[^>]*>([^<]*(?:<[^/][^>]*>[^<]*<\/[^>]+>[^<]*)*)<\/h3>/);
    let title = '';
    if (h3M) title = h3M[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!title) {
      const altM = block.match(/alt="([^"]+)"/);
      if (altM) title = altM[1].trim();
    }
    if (!title) title = path.split('/').slice(-2, -1)[0].replace(/-/g, ' ');

    const yearM = block.match(/\b(19[5-9]\d|20[0-3]\d)\b/);
    const year = yearM ? yearM[1] : '';

    const kmsM = block.match(/([\d][\d,.]*)\s*[Kk]ms\b/);
    const kms = kmsM ? `${kmsM[1]} Kms` : '';

    const priceM = block.match(/\$\s*([\d][\d,.]{2,})/);
    const price = priceM ? `$${priceM[1].replace(/\.(?=\d{3}\b)/g, ',')}` : '';

    vehicles.push({
      id, title, price, year, kms,
      img: imgM ? imgM[1] : '',
      dealer: dealer.name,
      dealerId: dealer.id,
    });
  }

  return vehicles;
}

async function loadDealer(dealer) {
  const allVehicles = [];
  const seenIds = new Set();

  const base = `https://ecuador.patiotuerca.com/dealers-profile/${dealer.slug}/${dealer.id}`;

  const r1 = await fetchUrl(base);
  if (!r1.ok) return allVehicles;

  const html1 = cleanHtml(r1.body);
  const totalPagesM = html1.match(/P[aá]gina\s+\d+\s+de\s+(\d+)/i);
  const totalPages = totalPagesM ? parseInt(totalPagesM[1]) : 1;

  for (const v of extractFromHtml(r1.body, dealer)) {
    if (v.id && !seenIds.has(v.id)) { seenIds.add(v.id); allVehicles.push(v); }
  }

  // Pages 2+ sequential (ScraperAPI render is heavy; avoid too much concurrency)
  for (let page = 2; page <= Math.min(totalPages, 25); page++) {
    const r = await fetchUrl(`${base}?vehiclePage=${page}`);
    if (!r.ok || !r.body) break;

    const found = extractFromHtml(r.body, dealer);
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
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');

  const dealerId = req.query.dealer;
  const debug = req.query.debug === '1';
  const list = dealerId ? DEALERS.filter(d => d.id === dealerId) : DEALERS;

  if (!SCRAPER_API_KEY) {
    return res.status(500).json({ error: 'SCRAPERAPI_KEY no configurada en variables de entorno' });
  }

  try {
    if (debug) {
      const d = list[0];
      const base = `https://ecuador.patiotuerca.com/dealers-profile/${d.slug}/${d.id}`;
      const r1 = await fetchUrl(base);
      const html1 = cleanHtml(r1.body);
      const totalPagesM = html1.match(/P[aá]gina\s+\d+\s+de\s+(\d+)/i);
      const found1 = extractFromHtml(r1.body, d);

      const idx = html1.indexOf('href="/vehicle/');
      const idx2 = html1.indexOf('href="/vehicle/', idx + 1);
      const cardBlock = idx >= 0 ? html1.slice(idx, idx2 > 0 ? idx2 : idx + 1500) : 'not found';

      return res.status(200).json({
        status: r1.status,
        bodyLen: r1.body.length,
        bodySnippet: r1.body.slice(0, 500),
        totalPages: totalPagesM ? parseInt(totalPagesM[1]) : 1,
        extractedCount: found1.length,
        sample: found1.slice(0, 3),
        cardBlock,
      });
    }

    const results = await Promise.all(list.map(loadDealer));
    const vehicles = results.flat();
    res.status(200).json({
      vehicles,
      total: vehicles.length,
      updated: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message), stack: String(e.stack).slice(0, 400) });
  }
};
