const crypto = require('crypto');

const REPO = process.env.GITHUB_REPO;
const TOKEN = process.env.GITHUB_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const BLOCKED_PATH = 'public/blocked.json';
const VEHICLES_PATH = 'public/vehicles.json';

function samePassword(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function github(path, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'autos-quito-admin',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub respondio ${res.status} para ${path}`);
  return res.json();
}

async function readJson(path) {
  const file = await github(path);
  return {
    sha: file.sha,
    data: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')),
  };
}

async function writeJson(path, sha, data, message) {
  await github(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64'),
      sha,
    }),
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo no permitido' });
  }
  if (!REPO || !TOKEN || !ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'Servidor no configurado' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const { id, password } = body || {};

  if (!samePassword(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Contrasena incorrecta' });
  }
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'ID invalido' });
  }

  try {
    const blocked = await readJson(BLOCKED_PATH);
    if (!blocked.data.ids.includes(id)) {
      blocked.data.ids.push(id);
      await writeJson(BLOCKED_PATH, blocked.sha, blocked.data, `Bloquea vehiculo ${id}`);
    }

    const catalog = await readJson(VEHICLES_PATH);
    const before = catalog.data.vehicles.length;
    catalog.data.vehicles = catalog.data.vehicles.filter(v => v.id !== id);
    catalog.data.total = catalog.data.vehicles.length;
    const removed = before - catalog.data.vehicles.length;
    if (removed > 0) {
      await writeJson(VEHICLES_PATH, catalog.sha, catalog.data, `Elimina vehiculo ${id}`);
    }

    return res.status(200).json({ ok: true, removed });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
