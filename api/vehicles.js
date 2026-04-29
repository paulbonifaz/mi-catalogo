const https = require('https');

const DEALERS = [
  { id: '1167', name: 'Autos Quito', slug: 'autos-quito' },
  { id: '1378', name: 'Sucursal', slug: 'autos-quito-sucursal' },
  { id: '1570', name: '10 de Agosto', slug: 'autos-quito-10-de-agosto' },
];

function fetchUrl(url, headers = {}) {
  return new Promise((resolve) => {
    const doGet = (u, hops) => {
      if (hops > 8) return resolve({ ok: false, body: '', status: 0, resHeaders: {} });
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
        res.on('end', () => resolve({ ok: res.statusCode < 400, body, status: res.statusCode, resHeaders: res.headers }));
      });
      req.on('error', () => resolve({ ok: false, body: '', status: -1, resHeaders: {} }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, body: '', status: -2, resHeaders: {} }); });
    };
    doGet(url, 0);
  });
}

function cleanHtml(raw) {
  return raw.replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/\\n/g, '\n').replace(/<!--\s*-->/g, '');
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

// Get RSC key from the page's JS bundle
async function getRscKey(dealer) {
  const base = `https://ecuador.patiotuerca.com/dealers-profile/${dealer.slug}/${dealer.id}`;
  const r = await fetchUrl(base);
  if (!r.ok) return null;
  // Look for RSC key patterns in HTML - usually in script tags or meta
  // Pattern: "vehiclePage","rsc":"XXXXX" or similar
  const patterns = [
    /"rsc"\s*:\s*"([a-z0-9]+)"/i,
    /rscKey['"]\s*:\s*['"]([a-z0-9]+)['"]/i,
    /_rsc=([a-z0-9]+)/i,
  ];
  for (const pat of patterns) {
    const m = r.body.match(pat);
    if (m) return m[1];
  }
  // Try to find it in the JS chunks referenced
  const chunkM = r.body.match(/src="([^"]*3051[^"]*\.js)"/);
  if (chunkM) {
    const chunkUrl = chunkM[1].startsWith('http') ? chunkM[1] : `https://ecuador.patiotuerca.com${chunkM[1]}`;
    const cr = await fetchUrl(chunkUrl);
    if (cr.ok) {
      const km = cr.body.match(/vehiclePage[^}]{0,200}_rsc[=:]["']?([a-z0-9]{4,8})/i);
      if (km) return km[1];
    }
  }
  return null;
}

async function loadDealer(dealer) {
  const allVehicles = [];
  const seenIds = new Set();

  const base = `https://ecuador.patiotuerca.com/dealers-profile/${dealer.slug}/${dealer.id}`;

  // Page 1
  const r1 = await fetchUrl(base);
  if (!r1.ok) return allVehicles;

  const html1 = cleanHtml(r1.body);
  const totalPagesM = html1.match(/P[aá]gina\s+\d+\s+de\s+(\d+)/i);
  const totalPages = totalPagesM ? parseInt(totalPagesM[1]) : 1;

  for (const v of extractFromHtml(r1.body, dealer)) {
    if (v.id && !seenIds.has(v.id)) { seenIds.add(v.id); allVehicles.push(v); }
  }

  if (totalPages <= 1) return allVehicles;

  // For pages 2+: fetch the full page with vehiclePage param
  // Patiotuerca's Next.js app reads vehiclePage from URL params in the browser
  // We need to simulate a browser navigation - send the full page request with cookie
  // Key: send the request as if it's a full page navigation (not RSC)
  for (let page = 2; page <= Math.min(totalPages, 25); page++) {
    // Try as full HTML page request (no RSC headers) with vehiclePage param
    const url = `${base}?vehiclePage=${page}`;
    const r = await fetchUrl(url, {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    });

    if (!r.ok || !r.body) break;

    const found = extractFromHtml(r.body, dealer);
    let added = 0;
    for (const v of found) {
      if (v.id && !seenIds.has(v.id)) { seenIds.add(v.id); allVehicles.push(v); added++; }
    }
    // If we got vehicles but they're all duplicates, the server ignores vehiclePage
    if (added === 0 && found.length > 0) break;
    if (found.length === 0) break;
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

      // Test vehiclePage as full HTML request
      const r2html = await fetchUrl(`${base}?vehiclePage=2`, {
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Cache-Control': 'no-cache',
      });
      const found2html = extractFromHtml(r2html.body, d);
      const r1 = await fetchUrl(base);
      const found1 = extractFromHtml(r1.body, d);
      const html1 = cleanHtml(r1.body);
      const totalPagesM = html1.match(/P[aá]gina\s+\d+\s+de\s+(\d+)/i);

      // Check what page indicator says in the vehiclePage=2 response
      const html2 = cleanHtml(r2html.body);
      const pageIndicator2 = html2.match(/P[aá]gina\s+\d+\s+de\s+\d+/i)?.[0] || 'not found';

      return res.status(200).json({
        totalPages: totalPagesM ? parseInt(totalPagesM[1]) : 1,
        page1Count: found1.length,
        page2htmlStatus: r2html.status,
        page2htmlLen: r2html.body.length,
        page2Count: found2html.length,
        page2NewIds: found2html.filter(v => !found1.find(v1=>v1.id===v.id)).length,
        page2Ids: found2html.map(v=>v.id),
        pageIndicatorOnPage2Response: pageIndicator2,
        page2Sample: found2html.slice(0,2),
      });
    }

    const results = await Promise.all(list.map(loadDealer));
    const vehicles = results.flat();
    res.status(200).json({ vehicles, total: vehicles.length, updated: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e.message), stack: String(e.stack).slice(0,400) });
  }
};
