// Accept self-signed / unverifiable certs (Docker container has no root CA bundle)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

require('dotenv').config();
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');

// ── Configuration ─────────────────────────────────────────────────────────────

const WEBHOOK_URL   = process.env.DISCORD_WEBHOOK_URL;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS, 10) || 5000;

if (!WEBHOOK_URL) {
    console.error('[ERROR] DISCORD_WEBHOOK_URL is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
}

// ── Oref API ──────────────────────────────────────────────────────────────────
// Direct call to the Home Front Command (Pikud Ha'oref) live alert endpoint.
// Headers sourced from the official web app – without them the API returns 403.

const OREF_URL = 'https://www.oref.org.il/WarningMessages/Alert/alerts.json';

const OREF_HEADERS = {
    'Referer':          'https://www.oref.org.il/',
    'X-Requested-With': 'XMLHttpRequest',
    'Accept':           'application/json, text/javascript, */*; q=0.01',
    'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language':  'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
};

// ── Israeli proxy rotation ────────────────────────────────────────────────────
// The Oref API is geo-restricted to Israeli IPs.
// PROXY_URL env var overrides the built-in list (format: http://host:port).
// The bot rotates through the list automatically on 403 or connection failure.

const PROXY_LIST = process.env.PROXY_URL
    ? [process.env.PROXY_URL]
    : [
        // Verified working 2026-03-13 — all HTTP 200 from oref.org.il
        // Using socks5:// — these proxies don't support HTTP CONNECT for HTTPS
        'socks5://51.85.49.118:8053',
        'socks5://51.85.49.118:39220',
        'socks5://51.85.49.118:176',
        'socks5://51.85.49.118:2887',
        'socks5://51.85.49.118:6116',
        'socks5://51.85.49.118:50918',
        'socks5://51.85.49.118:8050',
        'socks5://51.85.49.118:1521',
        'socks5://51.85.49.118:22901',
    ];

let proxyIndex = 0;

/** Returns a SocksProxyAgent for the current proxy entry. */
function currentAgent() {
    return new SocksProxyAgent(PROXY_LIST[proxyIndex % PROXY_LIST.length]);
}

/** Rotates to the next proxy and logs the switch. */
function rotateProxy(reason) {
    const failed = PROXY_LIST[proxyIndex % PROXY_LIST.length];
    proxyIndex++;
    const next = PROXY_LIST[proxyIndex % PROXY_LIST.length];
    console.warn(`[PROXY] ${reason} — rotating from ${failed} → ${next}`);
}

// ── Alert category → human-readable label + Discord colour ───────────────────
// Category IDs as used by the Oref API (field: "cat")

const CAT_META = {
    '1':  { label: '🚀 Missile / Rocket Fire',        color: 0xFF0000 },
    '2':  { label: '🔴 Terrorist Infiltration',        color: 0x8B0000 },
    '3':  { label: '☢️ Radiological / NBC Threat',     color: 0x9400D3 },
    '4':  { label: '☢️ Hazardous Materials',           color: 0xFFA500 },
    '5':  { label: '🌊 Tsunami',                       color: 0x1E90FF },
    '6':  { label: '✈️ Hostile Aircraft Intrusion',    color: 0xFF4500 },
    '7':  { label: '🌍 Earthquake',                    color: 0xA0522D },
    '13': { label: '🔴 Terrorist Infiltration',        color: 0x8B0000 },
    '101':{ label: '🟠 Drill – Missile / Rocket Fire', color: 0xFFC0CB },
    '102':{ label: '🟠 Drill – Terrorist Infiltration',color: 0xFFC0CB },
    '103':{ label: '🟠 Drill – Radiological',          color: 0xFFC0CB },
    '104':{ label: '🟠 Drill – Hazardous Materials',   color: 0xFFC0CB },
    '105':{ label: '🟠 Drill – Tsunami',               color: 0xFFC0CB },
    '106':{ label: '🟠 Drill – Hostile Aircraft',      color: 0xFFC0CB },
    '107':{ label: '🟠 Drill – Earthquake',            color: 0xFFC0CB },
};

// ── State ─────────────────────────────────────────────────────────────────────

// Track the last alert ID we posted so we never double-post.
let lastPostedId = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Builds a Discord embed from a parsed Oref alert object.
 * @param {{ id: string, cat: string, title: string, data: string[], desc: string }} alert
 */
function buildEmbed(alert) {
    const meta   = CAT_META[String(alert.cat)] || { label: '⚠️ Emergency Alert', color: 0x808080 };
    const cities = Array.isArray(alert.data) && alert.data.length
        ? alert.data.join(', ')
        : 'Unknown location';

    const fields = [];
    if (alert.desc) fields.push({ name: 'Instructions', value: alert.desc,       inline: false });
    if (alert.id)   fields.push({ name: 'Alert ID',     value: String(alert.id), inline: true  });

    return {
        title:       meta.label,
        description: `**Areas affected:**\n${cities}`,
        color:       meta.color,
        fields,
        footer:    { text: `RedAlert Bot • ${new Date().toUTCString()}` },
        thumbnail: { url: 'https://www.oref.org.il/Shared/ClientSide/images/oref-logo.png' },
    };
}

/**
 * Posts an embed to the Discord webhook.
 * @param {object} embed
 */
async function postToDiscord(embed) {
    try {
        await axios.post(WEBHOOK_URL, { embeds: [embed] });
        console.log('[INFO] Posted alert to Discord.');
    } catch (err) {
        const status  = err.response?.status ?? 'N/A';
        const details = err.response?.data   ? JSON.stringify(err.response.data) : err.message;
        console.error(`[ERROR] Discord webhook failed (HTTP ${status}): ${details}`);
    }
}

// ── Main polling loop ─────────────────────────────────────────────────────────

async function poll() {
    const proxyUrl = PROXY_LIST[proxyIndex % PROXY_LIST.length];
    try {
        const res = await axios.get(OREF_URL, {
            headers: OREF_HEADERS,
            httpsAgent: currentAgent(),
            proxy: false,          // disable axios built-in proxy (causes 400)
            timeout: 10000,        // proxy adds ~300ms latency, give it room
            validateStatus: () => true,
        });

        if (res.status === 403 || res.status === 400) {
            rotateProxy(`HTTP ${res.status}`);
            return;
        }

        if (res.status !== 200) {
            console.error(`[ERROR] Oref API returned HTTP ${res.status} via ${proxyUrl}`);
            return;
        }

        // API returns an empty body / whitespace when no alerts are active
        const raw = typeof res.data === 'string' ? res.data.trim() : JSON.stringify(res.data).trim();
        if (!raw || raw === '{}' || raw === 'null') return;

        const alert = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
        if (!alert?.data?.length) return;

        // De-duplicate by alert ID (stable for the life of an active alert)
        const alertId = String(alert.id ?? `${alert.cat}|${[...alert.data].sort().join(',')}`);
        if (alertId === lastPostedId) return;

        lastPostedId = alertId;
        console.log(`[ALERT] id:${alertId}  cat:${alert.cat}  cities:${alert.data.join(', ')}`);

        await postToDiscord(buildEmbed(alert));

    } catch (err) {
        // Connection-level failure (ECONNREFUSED, ETIMEDOUT, etc.) — rotate proxy
        rotateProxy(err.message);
    } finally {
        setTimeout(poll, POLL_INTERVAL);
    }
}

// ── Startup ───────────────────────────────────────────────────────────────────

console.log(`[INFO] RedAlert Discord Bot starting — polling every ${POLL_INTERVAL}ms`);
console.log(`[INFO] Proxy pool: ${PROXY_LIST.length} proxies. Starting with ${PROXY_LIST[0]}`);
poll();
