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

// Extract vehicle links from dealer listing page
function extractLinks(html) {
  const links = [];
  const seen = new Set();
  const re = /href="(\/vehicle\/[^"?#]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const path = m[1];
    if (!seen.has(path)) {
      seen.add(path);
      links.push(path);
    }
  }
  return links;
}

// Extract vehicle data from individual vehicle page
function extractVehicleData(html, path, dealer) {
  // Try to get __NEXT_DATA__ from individual vehicle page
  const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(\{[\s\S]*?\})<\/script>/);
  if (ndMatch) {
    try {
      const nd = JSON.parse(ndMatch[1]);
      const flat = JSON.stringify(nd);
      const brand   = (flat.match(/"brand"\s*:\s*"([^"]+)"/) || [])[1] || '';
      const model   = (flat.match(/"model"\s*:\s*"([^"]+)"/) || [])[1] || '';
      const version = (flat.match(/"version"\s*:\s*"([^"]+)"/) || [])[1] || '';
      const price   = (flat.match(/"price"\s*:\s*(\d+)/) || [])[1] || '';
      const year    = (flat.match(/"year"\s*:\s*(\d{4})/) || [])[1] || '';
      const mileage = (flat.match(/"mileage"\s*:\s*(\d+)/) || [])[1] || '';
      const img     = (flat.match(/"mainImage"\s*:\s*"([^"]+)"/) || [])[1] || '';
      const id      = path.split('/').pop();
      if (brand && price) {
        return {
          id,
          title: [brand, model, version].filter(Boolean).join(' · '),
          price: `$${Number(price).toLocaleString('en-US')}`,
          year,
          kms: mileage ? `${Number(mileage).toLocaleString('en-US')} Kms` : '',
          img: img.replace(/\\\//g,'/').replace(/\\u002F/g,'/'),
          url: `https://ecuador.patiotuerca.com${path}`,
          dealer: dealer.name,
          dealerId: dealer.id,
        };
      }
    } catch(_) {}
  }

  // Fallback: parse HTML meta tags and OG tags
  const title  = (html.match(/<meta property="og:title" content="([^"]+)"/) || 
                  html.match(/<title>([^<]+)<\/title>/) || [])[1] || '';
  const img    = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] || '';
  const desc   = (html.match(/<meta property="og:description" content="([^"]+)"/) || [])[1] || '';
  const priceM = html.match(/\$\s*([\d,]+)/);
  const yearM  = html.match(/\b(19[89]\d|20[012]\d)\b/);
  const kmM    = html.match(/([\d.,]+)\s*[Kk]ms?/);
  const id     = path.split('/').pop();

  return {
    id,
    title: title.replace(/\s*\|.*$/, '').trim() || desc.slice(0,60) || id,
    price: priceM ? `$${priceM[1]}` : '',
    year:  yearM ? yearM[1] : '',
    kms:   kmM ? `${kmM[1]} Kms` : '',
    img,
    url: `https://ecuador.patiotuerca.com${path}`,
    dealer: dealer.name,
    dealerId: dealer.id,
  };
}

// Parse listing page for inline vehicle data (price/year/km shown in cards)
function extractFromListing(html, dealer) {
  const vehicles = [];
  const seen = new Set();

  // Patiotuerca renders cards - each card has image, title h3, year, kms, price
  // Strategy: split HTML by vehicle link, then parse each block
  const parts = html.split(/(?=<a[^>]+href="\/vehicle\/)/);

  for (const part of parts) {
    const linkM = part.match(/href="(\/vehicle\/([^"?#]+)\/(\d+))"/);
    if (!linkM) continue;
    const path = linkM[1];
    const id   = linkM[3];
    if (seen.has(id)) continue;
    seen.add(id);

    const block = part.slice(0, 1200);

    // Image from patiotuerca CDN
    const imgM  = block.match(/https:\/\/images\.patiotuerca\.com\/[^"'\s)]+/);
    // Title from h3
    const h3M   = block.match(/<h3[^>]*>\s*([^<]+)\s*<\/h3>/i);
    // Price $XX,XXX
    const priceM = block.match(/\$([\d,]+)/);
    // Year 4-digit
    const yearM  = block.match(/\b(19[89]\d|20[012]\d)\b/);
    // KMs
    const kmM    = block.match(/([\d.,]+)\s*Kms?/i);

    if (!priceM && !h3M) continue;

    vehicles.push({
      id,
      title: h3M ? h3M[1].trim() : path.split('/').slice(-2,-1)[0].replace(/-/g,' '),
      price: priceM ? `$${priceM[1]}` : '',
      year:  yearM  ? yearM[1]  : '',
      kms:   kmM    ? `${kmM[1]} Kms` : '',
      img:   imgM   ? imgM[0]   : '',
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
    if (!res.body.includes('Siguiente')) break;
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
      return res.status(200).json({
        status: r.status,
        ok: r.ok,
        bodyLen: r.body.length,
        vehicleLinkCount: (r.body.match(/href="\/vehicle\//g) || []).length,
        extractedCount: found.length,
        sample: found.slice(0, 3),
        // Show a snippet of HTML around first vehicle link for debugging
        htmlSnippet: (() => {
          const idx = r.body.indexOf('/vehicle/');
          return idx > 0 ? r.body.slice(Math.max(0,idx-200), idx+600) : 'not found';
        })(),
      });
    }

    const results = await Promise.all(list.map(loadDealer));
    const vehicles = results.flat();
    res.status(200).json({ vehicles, total: vehicles.length, updated: new Date().toISOString() });

  } catch (e) {
    res.status(500).json({ error: String(e.message), stack: String(e.stack).slice(0,400) });
  }
};
