const https = require('https');

const DEALERS = [
  { id: '1167', name: 'Autos Quito', slug: 'autos-quito' },
  { id: '1378', name: 'Sucursal', slug: 'autos-quito-sucursal' },
  { id: '1570', name: '10 de Agosto', slug: 'autos-quito-10-de-agosto' },
];

function fetchUrl(url, extraHeaders = {}) {
  return new Promise((resolve) => {
    const doGet = (u, hops) => {
      if (hops > 8) return resolve({ ok: false, body: '', status: 0 });
      const req = https.get(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          'Accept': 'text/html,application/json,*/*;q=0.9',
          'Accept-Language': 'es-EC,es;q=0.9',
          'Referer': 'https://ecuador.patiotuerca.com/',
          ...extraHeaders,
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

    const imgM   = block.match(/src="(https:\/\/images\.patiotuerca\.com\/[^"]+\.jpg)"/);
    const h3M    = block.match(/<h3[^>]*>([^<]+)<\/h3>/);
    const altM   = block.match(/alt="([^"]+)"/);
    const title  = h3M ? h3M[1].trim() : (altM ? altM[1].trim() : '');
    const yearM  = block.match(/<p class="text-sm font-bold[^"]*">\s*(\d{4})\s*<\/p>/);
    const year   = yearM ? yearM[1] : (block.match(/\b(19[89]\d|20[012]\d)\b/) || [])[1] || '';
    const kmsM   = block.match(/<span>\s*([\d,.']+)\s*Kms\s*<\/span>/i);
    const kms    = kmsM ? `${kmsM[1]} Kms` : '';
    const priceM = block.match(/<span class="text-lg font-semibold[^"]*">\s*\$([\d,.']+)\s*<\/span>/);
    const price  = priceM ? `$${priceM[1]}` : '';

    vehicles.push({
      id, title: title || id, price, year, kms,
      img: imgM ? imgM[1] : '',
      dealer: dealer.name, dealerId: dealer.id,
    });
  }
  return vehicles;
}

// Try to find Next.js build ID from the page HTML
function getBuildId(html) {
  const m = html.match(/"buildId"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

async function loadDealer(dealer) {
  const allVehicles = [];
  const seenIds = new Set();

  const baseUrl = `https://ecuador.patiotuerca.com/dealers-profile/${dealer.slug}/${dealer.id}`;

  // Fetch page 1 to get build ID and total pages
  const r1 = await fetchUrl(baseUrl);
  if (!r1.ok) return allVehicles;

  const html1 = cleanHtml(r1.body);
  const totalPagesM = html1.match(/P[aá]gina\s+\d+\s+de\s+(\d+)/i);
  const totalPages = totalPagesM ? parseInt(totalPagesM[1]) : 1;
  const buildId = getBuildId(r1.body);

  // Add page 1 vehicles
  for (const v of extractFromPage(r1.body, dealer)) {
    if (v.id && !seenIds.has(v.id)) { seenIds.add(v.id); allVehicles.push(v); }
  }

  // Try Next.js data endpoint for subsequent pages
  // Pattern: /_next/data/{buildId}/dealers-profile/{slug}/{id}.json?page=2
  if (buildId) {
    for (let page = 2; page <= Math.min(totalPages, 25); page++) {
      const nextUrl = `https://ecuador.patiotuerca.com/_next/data/${buildId}/dealers-profile/${dealer.slug}/${dealer.id}.json?page=${page}&dealerSlug=${dealer.slug}&dealerId=${dealer.id}`;
      const nr = await fetchUrl(nextUrl, { 'Accept': 'application/json' });

      if (nr.ok && nr.body) {
        try {
          const data = JSON.parse(nr.body);
          // Walk the pageProps to find vehicle listings
          const flat = JSON.stringify(data);
          const vehicleRe = /"id"\s*:\s*"?(\d{5,})"?[^}]{0,600}"slug"\s*:\s*"([^"]+)"/g;
          let vm;
          while ((vm = vehicleRe.exec(flat)) !== null) {
            const vid = vm[1];
            if (seenIds.has(vid)) continue;
            const chunk = flat.slice(vm.index, vm.index + 800);
            const brandM  = chunk.match(/"brand"\s*:\s*"([^"]+)"/);
            const modelM  = chunk.match(/"model"\s*:\s*"([^"]+)"/);
            const verM    = chunk.match(/"version"\s*:\s*"([^"]+)"/);
            const priceM2 = chunk.match(/"price"\s*:\s*(\d+)/);
            const yearM2  = chunk.match(/"year"\s*:\s*(\d{4})/);
            const kmM2    = chunk.match(/"mileage"\s*:\s*(\d+)/);
            const imgM2   = chunk.match(/"mainImage"\s*:\s*"([^"]+)"/);
            if (!brandM && !priceM2) continue;
            seenIds.add(vid);
            allVehicles.push({
              id: vid,
              title: [brandM?.[1], modelM?.[1], verM?.[1]].filter(Boolean).join(' · '),
              price: priceM2 ? `$${Number(priceM2[1]).toLocaleString('en-US')}` : '',
              year: yearM2?.[1] || '',
              kms: kmM2 ? `${Number(kmM2[1]).toLocaleString('en-US')} Kms` : '',
              img: imgM2 ? imgM2[1].replace(/\\\//g, '/') : '',
              dealer: dealer.name, dealerId: dealer.id,
            });
          }
          continue; // next page
        } catch (_) {}
      }

      // Fallback: try HTML with offset param
      const offsetUrl = `${baseUrl}?offset=${(page-1)*12}`;
      const or = await fetchUrl(offsetUrl);
      if (or.ok) {
        const found = extractFromPage(or.body, dealer);
        let added = 0;
        for (const v of found) {
          if (v.id && !seenIds.has(v.id)) { seenIds.add(v.id); allVehicles.push(v); added++; }
        }
        if (added === 0) break;
      } else break;
    }
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
      const baseUrl = `https://ecuador.patiotuerca.com/dealers-profile/${d.slug}/${d.id}`;
      const r1 = await fetchUrl(baseUrl);
      const buildId = getBuildId(r1.body);
      const html1 = cleanHtml(r1.body);
      const totalPagesM = html1.match(/P[aá]gina\s+\d+\s+de\s+(\d+)/i);

      // Test Next.js data endpoint
      let nextDataTest = null;
      if (buildId) {
        const nextUrl = `https://ecuador.patiotuerca.com/_next/data/${buildId}/dealers-profile/${d.slug}/${d.id}.json?page=2&dealerSlug=${d.slug}&dealerId=${d.id}`;
        const nr = await fetchUrl(nextUrl, { 'Accept': 'application/json' });
        nextDataTest = { url: nextUrl, status: nr.status, bodyStart: nr.body.slice(0, 300) };
      }

      // Test a few other offset/pagination approaches
      const tests = {};
      for (const suffix of ['?offset=12', '?skip=12', '?start=12', '?from=12']) {
        const r = await fetchUrl(baseUrl + suffix);
        const vs = extractFromPage(r.body, d);
        tests[suffix] = { status: r.status, count: vs.length, firstId: vs[0]?.id };
      }

      return res.status(200).json({
        buildId,
        totalPages: totalPagesM ? parseInt(totalPagesM[1]) : 1,
        nextDataTest,
        offsetTests: tests,
      });
    }

    const results = await Promise.all(list.map(loadDealer));
    const vehicles = results.flat();
    res.status(200).json({ vehicles, total: vehicles.length, updated: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e.message), stack: String(e.stack).slice(0, 400) });
  }
};
