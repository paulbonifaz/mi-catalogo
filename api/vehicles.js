const https = require('https');

const DEALERS = [
  { id: '1167', name: 'Autos Quito', slug: 'autos-quito' },
  { id: '1378', name: 'Sucursal', slug: 'autos-quito-sucursal' },
  { id: '1570', name: '10 de Agosto', slug: 'autos-quito-10-de-agosto' },
];

function getPage(url) {
  return new Promise((resolve) => {
    const doGet = (u, hops) => {
      if (hops > 8) return resolve({ ok: false, body: '' });
      https.get(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          'Accept': 'text/html,*/*;q=0.9',
          'Accept-Language': 'es-EC,es;q=0.9',
        },
        timeout: 20000,
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
      }).on('error', () => resolve({ ok: false, body: '', status: -1 }));
    };
    doGet(url, 0);
  });
}

function unescapeHtml(raw) {
  // The body has \" escaped quotes — unescape to get real HTML
  return raw
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, ' ');
}

function extractFromListing(rawBody, dealer) {
  const vehicles = [];
  const seen = new Set();

  // Unescape first so our regex work on real HTML
  const html = unescapeHtml(rawBody);

  // Find all vehicle anchor start positions
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

    // Take a generous block — next anchor or +3000 chars
    const end = matches[i + 1] ? matches[i + 1].index : index + 3000;
    const block = html.slice(index, Math.min(end, index + 3000));

    // Image src from CDN
    const imgM  = block.match(/src="(https:\/\/images\.patiotuerca\.com\/[^"]+\.jpg)"/);
    // Title from alt attribute
    const altM  = block.match(/alt="([^"]+)"/);
    // Price: $10,990 or $60.900 — appears as text, could be comma or period separated
    const priceM = block.match(/\$\s*([\d][0-9,.']*[0-9])/);
    // Year 4-digit
    const yearM  = block.match(/\b(19[89]\d|20[012]\d)\b/);
    // KMs: 380,000 Kms or 380.000 Kms
    const kmM    = block.match(/([\d][0-9,.]*)\s*Kms?/i);

    vehicles.push({
      id,
      title: altM   ? altM[1].trim()  : path.split('/').slice(-2,-1)[0].replace(/-/g,' '),
      price: priceM ? `$${priceM[1]}` : '',
      year:  yearM  ? yearM[1]        : '',
      kms:   kmM    ? `${kmM[1]} Kms` : '',
      img:   imgM   ? imgM[1]         : '',
      url:   `https://ecuador.patiotuerca.com${path}`,
      dealer: dealer.name,
      dealerId: dealer.id,
    });
  }

  return vehicles;
}

async function loadDealer(dealer) {
  const allVehicles = [];
  const seenIds = new Set();

  for (let page = 1; page <= 20; page++) {
    const url = `https://ecuador.patiotuerca.com/dealers-profile/${dealer.slug}/${dealer.id}?page=${page}`;
    const res = await getPage(url);
    if (!res.ok || !res.body) break;

    const found = extractFromListing(res.body, dealer);
    if (found.length === 0) break;

    let added = 0;
    for (const v of found) {
      if (v.id && !seenIds.has(v.id)) {
        seenIds.add(v.id);
        allVehicles.push(v);
        added++;
      }
    }
    if (added === 0) break;

    const unescaped = unescapeHtml(res.body);
    if (!unescaped.includes('Siguiente')) break;
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
      const url = `https://ecuador.patiotuerca.com/dealers-profile/${d.slug}/${d.id}?page=1`;
      const r = await getPage(url);
      const found = extractFromListing(r.body, d);

      // Show unescaped block of first card to verify price/kms presence
      const html = unescapeHtml(r.body);
      const idx = html.indexOf('href="/vehicle/');
      const cardBlock = idx >= 0 ? html.slice(idx, idx + 1200) : 'not found';

      return res.status(200).json({
        extractedCount: found.length,
        sample: found.slice(0, 3),
        cardBlock,
      });
    }

    const results = await Promise.all(list.map(loadDealer));
    const vehicles = results.flat();
    res.status(200).json({ vehicles, total: vehicles.length, updated: new Date().toISOString() });

  } catch (e) {
    res.status(500).json({ error: String(e.message), stack: String(e.stack).slice(0, 400) });
  }
};
