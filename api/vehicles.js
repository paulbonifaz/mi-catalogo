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
          'Accept': '*/*',
          'Accept-Language': 'es-EC,es;q=0.9',
          'Referer': 'https://ecuador.patiotuerca.com/',
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

async function findApiInChunks(dealer) {
  // Get the RSC payload which contains chunk references
  const base = `https://ecuador.patiotuerca.com/dealers-profile/${dealer.slug}/${dealer.id}`;
  const rsc = await fetchUrl(base + '?_rsc=1', { 'RSC': '1' });
  
  // Extract all JS chunk URLs from the RSC response
  const chunkMatches = [...rsc.body.matchAll(/static\/chunks\/([^"'\s,]+\.js)/g)];
  const chunks = [...new Set(chunkMatches.map(m => m[1]))];

  // Search through chunks for API endpoint patterns
  for (const chunk of chunks.slice(0, 15)) {
    const url = `https://ecuador.patiotuerca.com/_next/static/chunks/${chunk}`;
    const r = await fetchUrl(url);
    if (!r.ok) continue;

    // Look for API fetch patterns
    if (r.body.includes('dealer') && (r.body.includes('fetch') || r.body.includes('axios'))) {
      // Extract URL patterns near "dealer"
      const apiPatterns = [];
      const re = /["'`]([^"'`]*(?:api|search|listing|vehicle)[^"'`]*dealer[^"'`]{0,100})["'`]/gi;
      let m2;
      while ((m2 = re.exec(r.body)) !== null) {
        apiPatterns.push(m2[1].slice(0, 150));
      }
      const re2 = /["'`]([^"'`]*dealer[^"'`]*(?:api|search|listing|vehicle)[^"'`]{0,100})["'`]/gi;
      while ((m2 = re2.exec(r.body)) !== null) {
        apiPatterns.push(m2[1].slice(0, 150));
      }
      if (apiPatterns.length > 0) {
        return { chunk, apiPatterns: [...new Set(apiPatterns)].slice(0, 10) };
      }
    }
  }
  return { chunks: chunks.slice(0, 10), notFound: true };
}

async function loadDealer(dealer) {
  const allVehicles = [];
  const seenIds = new Set();

  const base = `https://ecuador.patiotuerca.com/dealers-profile/${dealer.slug}/${dealer.id}`;
  const r1 = await fetchUrl(base);
  if (!r1.ok) return allVehicles;

  for (const v of extractFromHtml(r1.body, dealer)) {
    if (v.id && !seenIds.has(v.id)) { seenIds.add(v.id); allVehicles.push(v); }
  }

  // Extract all vehicle IDs referenced in the RSC payload for all pages
  // The RSC payload for the dealer page contains references to all vehicles in the listing
  const rscFull = await fetchUrl(base + '?_rsc=1', { 'RSC': '1' });
  if (rscFull.ok) {
    // Look for vehicle IDs in RSC payload
    const idRe = /\/vehicle\/[^/"]+\/(\d{6,})/g;
    let m;
    const rscIds = new Set();
    while ((m = idRe.exec(rscFull.body)) !== null) rscIds.add(m[1]);
    
    // If RSC has more IDs than page 1, fetch those individual vehicle pages
    const newIds = [...rscIds].filter(id => !seenIds.has(id));
    if (newIds.length > 0) {
      const batches = [];
      for (let i = 0; i < newIds.length; i += 6) batches.push(newIds.slice(i, i+6));
      for (const batch of batches) {
        const results = await Promise.all(batch.map(id => 
          fetchUrl(`https://ecuador.patiotuerca.com/vehicle/${id}`)
        ));
        for (let i = 0; i < results.length; i++) {
          const r = results[i]; const id = batch[i];
          if (!r.ok) continue;
          const html = cleanHtml(r.body);
          const brandM  = html.match(/["']brand["']\s*:\s*["']([^"']+)["']/);
          const modelM  = html.match(/["']model["']\s*:\s*["']([^"']+)["']/);
          const priceM  = html.match(/["']price["']\s*:\s*(\d+)/);
          const yearM   = html.match(/["']year["']\s*:\s*(\d{4})/);
          const kmM     = html.match(/["']mileage["']\s*:\s*(\d+)/);
          const imgM    = html.match(/["']mainImage["']\s*:\s*["']([^"']+)["']/);
          seenIds.add(id);
          allVehicles.push({
            id,
            title: [brandM?.[1], modelM?.[1]].filter(Boolean).join(' · ') || id,
            price: priceM ? `$${Number(priceM[1]).toLocaleString('en-US')}` : '',
            year: yearM?.[1] || '', kms: kmM ? `${Number(kmM[1]).toLocaleString('en-US')} Kms` : '',
            img: imgM?.[1]?.replace(/\\\//g,'/') || '',
            dealer: dealer.name, dealerId: dealer.id,
          });
        }
      }
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
      const apiInfo = await findApiInChunks(d);
      
      // Also check RSC for vehicle IDs
      const base = `https://ecuador.patiotuerca.com/dealers-profile/${d.slug}/${d.id}`;
      const rsc = await fetchUrl(base + '?_rsc=1', { 'RSC': '1' });
      const idRe = /\/vehicle\/[^/"]+\/(\d{6,})/g;
      let m;
      const rscIds = new Set();
      while ((m = idRe.exec(rsc.body)) !== null) rscIds.add(m[1]);

      return res.status(200).json({
        rscLen: rsc.body.length,
        rscVehicleIds: [...rscIds].length,
        rscIdSample: [...rscIds].slice(0, 5),
        apiSearch: apiInfo,
      });
    }

    const results = await Promise.all(list.map(loadDealer));
    const vehicles = results.flat();
    res.status(200).json({ vehicles, total: vehicles.length, updated: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e.message), stack: String(e.stack).slice(0,400) });
  }
};
