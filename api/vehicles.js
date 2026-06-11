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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'es-EC,es;q=0.9,en;q=0.8',
          'Accept-Encoding': 'identity',
          'Referer': 'https://ecuador.patiotuerca.com/',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
          'sec-ch-ua': '"Chromium";v="126", "Not.A/Brand";v="24"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'Cache-Control': 'no-cache',
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
        res.on('end', () => resolve({ ok: res.statusCode < 400, body, status: res.statusCode, headers: res.headers }));
      });
      req.on('error', (e) => resolve({ ok: false, body: '', status: -1, error: e.message }));
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

// Robust extraction: doesn't depend on exact Tailwind class names.
// Each vehicle card is delimited by an <a href="/vehicle/SLUG/ID"> anchor.
// Within the card block (until the next anchor) we look for:
//  - image: first images.patiotuerca.com src/srcSet
//  - title: <h3>...</h3> content (brand · model), fallback to alt or img alt
//  - year: a standalone 4-digit number 19xx/20xx
//  - kms: number followed by "Kms" (case-insensitive)
//  - price: $ followed by digits/commas/dots
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

    // Image: any patiotuerca CDN image, prefer .jpg/.jpeg/.png/.webp
    const imgM = block.match(/(https:\/\/images\.patiotuerca\.com\/[^"'\s)]+\.(?:jpe?g|png|webp))/i);

    // Title: prefer <h3>...</h3> text content
    const h3M = block.match(/<h3[^>]*>([^<]*(?:<[^/][^>]*>[^<]*<\/[^>]+>[^<]*)*)<\/h3>/);
    let title = '';
    if (h3M) {
      title = h3M[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    }
    if (!title) {
      const altM = block.match(/alt="([^"]+)"/);
      if (altM) title = altM[1].trim();
    }
    if (!title) {
      // fallback: derive from slug
      title = path.split('/').slice(-2, -1)[0].replace(/-/g, ' ');
    }

    // Year: standalone 4-digit year
    const yearM = block.match(/\b(19[5-9]\d|20[0-3]\d)\b/);
    const year = yearM ? yearM[1] : '';

    // KMs: number followed by Kms
    const kmsM = block.match(/([\d][\d,.]*)\s*[Kk]ms\b/);
    const kms = kmsM ? `${kmsM[1]} Kms` : '';

    // Price: $ followed by a number with thousands separators
    const priceM = block.match(/\$\s*([\d][\d,.]{2,})/);
    const price = priceM ? `$${priceM[1].replace(/\.(?=\d{3}\b)/g, ',')}` : '';

    vehicles.push({
      id,
      title,
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

  // Pages 2+ using vehiclePage param, in parallel batches of 3
  const pageNums = [];
  for (let p = 2; p <= Math.min(totalPages, 25); p++) pageNums.push(p);

  for (let i = 0; i < pageNums.length; i += 3) {
    const batch = pageNums.slice(i, i + 3);
    const results = await Promise.all(batch.map(p =>
      fetchUrl(`${base}?vehiclePage=${p}`)
    ));

    let anyNew = false;
    for (const r of results) {
      if (!r.ok || !r.body) continue;
      for (const v of extractFromHtml(r.body, dealer)) {
        if (v.id && !seenIds.has(v.id)) { seenIds.add(v.id); allVehicles.push(v); anyNew = true; }
      }
    }
    if (!anyNew) break;
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
      const r1 = await fetchUrl(base);
      const html1 = cleanHtml(r1.body);
      const totalPagesM = html1.match(/P[aá]gina\s+\d+\s+de\s+(\d+)/i);
      const found1 = extractFromHtml(r1.body, d);

      // Show raw block of first card for inspection
      const idx = html1.indexOf('href="/vehicle/');
      const idx2 = html1.indexOf('href="/vehicle/', idx + 1);
      const cardBlock = idx >= 0 ? html1.slice(idx, idx2 > 0 ? idx2 : idx + 1500) : 'not found';

      return res.status(200).json({
        status: r1.status,
        bodyLen: r1.body.length,
        responseHeaders: r1.headers,
        bodySnippet: r1.body.slice(0, 800),
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
