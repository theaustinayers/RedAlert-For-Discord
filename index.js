require('dotenv').config();
const axios = require('axios');

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

// ── Alert type → human-readable label + Discord colour ───────────────────────

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
    try {
        const res = await axios.get(OREF_URL, {
            headers: OREF_HEADERS,
            timeout: 4000,
            validateStatus: () => true, // handle all status codes manually
        });

        if (res.status !== 200) {
            console.error(`[ERROR] Oref API returned HTTP ${res.status}`);
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
        console.error('[ERROR] Poll failed:', err.message);
    } finally {
        setTimeout(poll, POLL_INTERVAL);
    }
}

// ── Startup ───────────────────────────────────────────────────────────────────

console.log(`[INFO] RedAlert Discord Bot starting — polling every ${POLL_INTERVAL}ms`);
poll();
