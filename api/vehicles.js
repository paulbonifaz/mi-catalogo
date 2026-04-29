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
          'Accept': 'application/json, text/html, */*',
          'Accept-Language': 'es-EC,es;q=0.9',
          'Referer': 'https://ecuador.patiotuerca.com/',
          'x-requested-with': 'XMLHttpRequest',
          ...headers,
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
        res.on('end', () => resolve({ ok: res.statusCode < 400, body, status: res.statusCode }));
      });
      req.on('error', () => resolve({ ok: false, body: '', status: -1 }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, body: '', status: -2 }); });
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
    const end = Math.min((matches[i+1]?.index || index + 4000), index + 4000);
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
      year: yearM?.[1] || (block.match(/\b(19[89]\d|20[012]\d)\b/) || [])[1] || '',
      kms: kmsM ? `${kmsM[1]} Kms` : '',
      img: imgM?.[1] || '',
      dealer: dealer.name, dealerId: dealer.id,
    });
  }
  return vehicles;
}

// Extract all vehicle IDs/slugs from the sitemap or search API
async function fetchViaSitemap(dealer) {
  // Try the sitemap to get all vehicle URLs for this dealer
  const sitemapUrls = [
    `https://ecuador.patiotuerca.com/sitemap-dealers-${dealer.id}.xml`,
    `https://ecuador.patiotuerca.com/sitemap.xml`,
  ];
  for (const url of sitemapUrls) {
    const r = await fetchUrl(url);
    if (!r.ok) continue;
    const matches = [...r.body.matchAll(/\/vehicle\/([^<\s]+)\/(\d+)/g)];
    if (matches.length > 0) return matches.map(m => ({ slug: m[1], id: m[2] }));
  }
  return [];
}

async function fetchViaSearchApi(dealer) {
  const vehicles = [];
  // Patiotuerca likely uses a search/listing API - try common patterns
  const apiCandidates = [
    `https://ecuador.patiotuerca.com/api/listings?dealerId=${dealer.id}&limit=200`,
    `https://ecuador.patiotuerca.com/api/vehicles?dealerId=${dealer.id}&limit=200`,
    `https://ecuador.patiotuerca.com/api/search?dealerId=${dealer.id}&size=200&country=ecuador`,
    `https://ecuador.patiotuerca.com/api/dealer/${dealer.id}/vehicles?limit=200`,
    // With auth header patterns some Next.js apps use
    `https://ecuador.patiotuerca.com/api/trpc/dealer.getVehicles?input={"dealerId":"${dealer.id}","page":1,"limit":200}`,
  ];
  for (const url of apiCandidates) {
    const r = await fetchUrl(url);
    if (!r.ok || !r.body) continue;
    try {
      const data = JSON.parse(r.body);
      const items = data.data || data.vehicles || data.results || data.items || data.hits || [];
      if (Array.isArray(items) && items.length > 12) {
        return { found: true, url, count: items.length, data };
      }
    } catch(_) {}
  }
  return { found: false };
}

async function loadDealer(dealer) {
  const allVehicles = [];
  const seenIds = new Set();

  // 1. Get page 1 HTML  
  const baseUrl = `https://ecuador.patiotuerca.com/dealers-profile/${dealer.slug}/${dealer.id}`;
  const r1 = await fetchUrl(baseUrl);
  if (!r1.ok) return allVehicles;

  const html1 = cleanHtml(r1.body);
  const totalPagesM = html1.match(/P[aá]gina\s+\d+\s+de\s+(\d+)/i);
  const totalPages = totalPagesM ? parseInt(totalPagesM[1]) : 1;

  // Add page 1 vehicles
  for (const v of extractFromHtml(r1.body, dealer)) {
    if (v.id && !seenIds.has(v.id)) { seenIds.add(v.id); allVehicles.push(v); }
  }

  if (totalPages <= 1) return allVehicles;

  // 2. Try to get vehicle list from sitemap
  const sitemapVehicles = await fetchViaSitemap(dealer);
  if (sitemapVehicles.length > 12) {
    // Fetch each vehicle page to get details — too slow for many vehicles
    // Instead, fetch each in batches to get price/year/kms from individual pages
    // For now use what we have from page 1 and supplement with basic info
  }

  // 3. Fetch individual vehicle pages in parallel to get full details
  // Get all vehicle IDs from sitemap or by scraping all pages sequentially
  // Since page param doesn't work, try RSC (React Server Components) endpoint
  // Next.js 13+ uses __rsc__ for client navigation
  const page2Rsc = await fetchUrl(baseUrl + '?_rsc=1', {
    'RSC': '1',
    'Next-Router-State-Tree': '%5B%22%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D',
    'Next-Url': `/dealers-profile/${dealer.slug}/${dealer.id}`,
  });

  // Try action-based pagination that Next.js uses internally
  const rscWithPage = await fetchUrl(baseUrl + '?page=2&_rsc=1', {
    'RSC': '1',
    'Next-Router-State-Tree': '%5B%22%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D',
  });

  // Extract vehicles from RSC response if it contains vehicle data
  if (rscWithPage.ok && rscWithPage.body.length > 1000) {
    const rscVehicles = extractVehiclesFromRSC(rscWithPage.body, dealer, seenIds);
    for (const v of rscVehicles) allVehicles.push(v);
  }

  return allVehicles;
}

function extractVehiclesFromRSC(rscBody, dealer, seenIds) {
  const vehicles = [];
  // RSC payload contains JSON-like data, search for vehicle patterns
  const clean = rscBody.replace(/\\"/g, '"').replace(/\\\//g, '/');
  const re = /"id"\s*:\s*"?(\d{5,})"?[^\n]{0,400}"brand"\s*:\s*"([^"]+)"[^\n]{0,200}"price"\s*:\s*(\d+)/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const id = m[1];
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const chunk = clean.slice(m.index, m.index + 600);
    const modelM = chunk.match(/"model"\s*:\s*"([^"]+)"/);
    const yearM  = chunk.match(/"year"\s*:\s*(\d{4})/);
    const kmM    = chunk.match(/"mileage"\s*:\s*(\d+)/);
    const imgM   = chunk.match(/"mainImage"\s*:\s*"([^"]+)"/);
    const slugM  = chunk.match(/"slug"\s*:\s*"([^"]+)"/);
    vehicles.push({
      id,
      title: [m[2], modelM?.[1]].filter(Boolean).join(' · '),
      price: `$${Number(m[3]).toLocaleString('en-US')}`,
      year: yearM?.[1] || '',
      kms: kmM ? `${Number(kmM[1]).toLocaleString('en-US')} Kms` : '',
      img: imgM ? imgM[1].replace(/\\\//g, '/') : '',
      url: slugM ? `https://ecuador.patiotuerca.com/vehicle/${slugM[1]}/${id}` : '',
      dealer: dealer.name, dealerId: dealer.id,
    });
  }
  return vehicles;
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

      // Test RSC endpoint
      const rsc1 = await fetchUrl(base + '?_rsc=1', { 'RSC': '1' });
      const rsc2 = await fetchUrl(base + '?page=2&_rsc=1', { 'RSC': '1', 'Next-Url': `/dealers-profile/${d.slug}/${d.id}` });

      // Test sitemap
      const sm = await fetchUrl(`https://ecuador.patiotuerca.com/sitemap-dealers-${d.id}.xml`);

      // Test search API
      const apiTest = await fetchViaSearchApi(d);

      // Test action endpoint
      const actionTest = await fetchUrl(`https://ecuador.patiotuerca.com/dealers-profile/${d.slug}/${d.id}`, {
        'Next-Action': '1',
      });

      return res.status(200).json({
        rsc1: { status: rsc1.status, len: rsc1.body.length, start: rsc1.body.slice(0, 200) },
        rsc2: { status: rsc2.status, len: rsc2.body.length, start: rsc2.body.slice(0, 200) },
        rsc2HasDifferentVehicles: rsc2.body.includes('1959004') ? 'same_as_p1' : 'different',
        sitemap: { status: sm.status, len: sm.body.length, start: sm.body.slice(0, 200) },
        searchApi: apiTest,
      });
    }

    const results = await Promise.all(list.map(loadDealer));
    const vehicles = results.flat();
    res.status(200).json({ vehicles, total: vehicles.length, updated: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e.message), stack: String(e.stack).slice(0, 400) });
  }
};
