const https = require('https');

const DEALERS = [
  { id: '1167', name: 'Autos Quito', slug: 'autos-quito' },
  { id: '1378', name: 'Sucursal', slug: 'autos-quito-sucursal' },
  { id: '1570', name: '10 de Agosto', slug: 'autos-quito-10-de-agosto' },
];

function getPage(url) {
  return new Promise((resolve) => {
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': 'text/html,*/*;q=0.9',
        'Accept-Language': 'es-EC,es;q=0.9',
      },
      timeout: 15000,
    };

    const doGet = (targetUrl, hops) => {
      if (hops > 8) return resolve({ ok: false, body: '', status: 0 });
      https.get(targetUrl, opts, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const loc = res.headers.location;
          const next = loc.startsWith('http') ? loc : `https://ecuador.patiotuerca.com${loc}`;
          res.resume();
          return doGet(next, hops + 1);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', d => { body += d; });
        res.on('end', () => resolve({ ok: res.statusCode === 200, body, status: res.statusCode }));
      }).on('error', () => resolve({ ok: false, body: '', status: -1 }))
        .on('timeout', () => resolve({ ok: false, body: '', status: -2 }));
    };

    doGet(url, 0);
  });
}

function extractVehicles(html, dealer) {
  const vehicles = [];
  const seen = new Set();

  // Try __NEXT_DATA__ first
  const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(\{[\s\S]*?\})<\/script>/);
  if (ndMatch) {
    try {
      const nd = JSON.parse(ndMatch[1]);
      const flat = JSON.stringify(nd);
      // Match vehicle objects: need id, brand, model, price
      const re = /"id"\s*:\s*(\d{5,})[^}]{0,400}"brand"\s*:\s*"([^"]+)"[^}]{0,400}"model"\s*:\s*"([^"]+)"[^}]{0,400}"price"\s*:\s*(\d+)/g;
      let m;
      while ((m = re.exec(flat)) !== null) {
        const id = m[1];
        if (seen.has(id)) continue;
        seen.add(id);
        const chunk = flat.slice(m.index, m.index + 800);
        const year    = (chunk.match(/"year"\s*:\s*(\d{4})/) || [])[1] || '';
        const mileage = (chunk.match(/"mileage"\s*:\s*(\d+)/) || [])[1] || '';
        const slug    = (chunk.match(/"slug"\s*:\s*"([^"]+)"/) || [])[1] || '';
        const img     = (chunk.match(/"mainImage"\s*:\s*"([^"]+)"/) || [])[1] || '';
        const ver     = (chunk.match(/"version"\s*:\s*"([^"]+)"/) || [])[1] || '';
        vehicles.push({
          id,
          title: [m[2], m[3], ver].filter(Boolean).join(' · '),
          price: `$${Number(m[4]).toLocaleString('en-US')}`,
          year,
          kms: mileage ? `${Number(mileage).toLocaleString('en-US')} Kms` : '',
          img: (img || '').replace(/\\\//g, '/').replace(/\\u002F/g, '/'),
          url: slug
            ? `https://ecuador.patiotuerca.com/vehicle/${slug.replace(/\\\//g,'/')}/${id}`
            : `https://ecuador.patiotuerca.com/vehicle/${id}`,
          dealer: dealer.name,
          dealerId: dealer.id,
        });
      }
      if (vehicles.length > 0) return vehicles;
    } catch (_) {}
  }

  // HTML fallback
  const linkRe = /href="(\/vehicle\/[^"?#]+\/(\d+))"/g;
  let m2;
  while ((m2 = linkRe.exec(html)) !== null) {
    const path = m2[1];
    const id   = m2[2];
    if (seen.has(id)) continue;
    seen.add(id);

    const s = Math.max(0, m2.index - 800);
    const block = html.slice(s, m2.index + 200);

    const priceM = block.match(/\$\s*([\d,]+)/);
    const yearM  = block.match(/\b(19[89]\d|20[012]\d)\b/);
    const kmM    = block.match(/([\d.,]+)\s*[Kk]ms?/);
    const imgM   = block.match(/src="(https:\/\/images\.patiotuerca\.com[^"]+)"/);
    const h3M    = block.match(/<h3[^>]*>([^<]+)<\/h3>/i);

    if (!priceM && !h3M) continue;

    vehicles.push({
      id,
      title: h3M ? h3M[1].trim() : path.split('/').slice(-2,-1)[0].replace(/-/g,' '),
      price: priceM ? `$${priceM[1]}` : '',
      year:  yearM ? yearM[1] : '',
      kms:   kmM   ? `${kmM[1]} Kms` : '',
      img:   imgM  ? imgM[1] : '',
      url:   `https://ecuador.patiotuerca.com${path}`,
      dealer: dealer.name,
      dealerId: dealer.id,
    });
  }

  return vehicles;
}

async function loadDealer(dealer) {
  const all = [];
  const seen = new Set();

  for (let page = 1; page <= 20; page++) {
    const url = `https://ecuador.patiotuerca.com/dealers-profile/${dealer.slug}/${dealer.id}?page=${page}`;
    const res = await getPage(url);

    if (!res.ok) break;

    const found = extractVehicles(res.body, dealer);
    if (found.length === 0) break;

    let added = 0;
    for (const v of found) {
      if (!seen.has(v.id)) {
        seen.add(v.id);
        all.push(v);
        added++;
      }
    }
    if (added === 0) break;

    if (!res.body.includes('Siguiente')) break;
  }

  return all;
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
      return res.status(200).json({
        status: r.status,
        ok: r.ok,
        bodyLen: r.body.length,
        hasNextData: r.body.includes('__NEXT_DATA__'),
        vehicleLinkCount: (r.body.match(/href="\/vehicle\//g) || []).length,
        first500: r.body.slice(0, 500),
      });
    }

    const results = await Promise.all(list.map(loadDealer));
    const vehicles = results.flat();
    res.status(200).json({ vehicles, total: vehicles.length, updated: new Date().toISOString() });

  } catch (e) {
    res.status(500).json({ error: String(e.message), stack: String(e.stack).slice(0, 300) });
  }
};
