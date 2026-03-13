require('dotenv').config();
const axios = require('axios');
const pikudHaoref = require('pikud-haoref-api');

// ── Configuration ────────────────────────────────────────────────────────────

const WEBHOOK_URL   = process.env.DISCORD_WEBHOOK_URL;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS, 10) || 5000;
const PROXY_URL     = process.env.PROXY_URL || null;

if (!WEBHOOK_URL) {
    console.error('[ERROR] DISCORD_WEBHOOK_URL is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
}

// ── Alert type → human-readable label + Discord colour ───────────────────────

const ALERT_META = {
    missiles:                     { label: '🚀 Missile / Rocket Fire',           color: 0xFF0000 },
    terroristInfiltration:        { label: '🔴 Terrorist Infiltration',           color: 0x8B0000 },
    hostileAircraftIntrusion:     { label: '✈️ Hostile Aircraft Intrusion',       color: 0xFF4500 },
    hazardousMaterials:           { label: '☢️ Hazardous Materials',              color: 0xFFA500 },
    earthQuake:                   { label: '🌍 Earthquake',                       color: 0xA0522D },
    tsunami:                      { label: '🌊 Tsunami',                          color: 0x1E90FF },
    radiologicalEvent:            { label: '☢️ Radiological Event',               color: 0x9400D3 },
    newsFlash:                    { label: 'ℹ️ News Flash / Early Warning',        color: 0x3498DB },
    missilesDrill:                { label: '🟠 Drill – Missile / Rocket Fire',    color: 0xFFC0CB },
    terroristInfiltrationDrill:   { label: '🟠 Drill – Terrorist Infiltration',   color: 0xFFC0CB },
    hostileAircraftIntrusionDrill:{ label: '🟠 Drill – Hostile Aircraft',         color: 0xFFC0CB },
    hazardousMaterialsDrill:      { label: '🟠 Drill – Hazardous Materials',      color: 0xFFC0CB },
    earthQuakeDrill:              { label: '🟠 Drill – Earthquake',               color: 0xFFC0CB },
    radiologicalEventDrill:       { label: '🟠 Drill – Radiological Event',       color: 0xFFC0CB },
    tsunamiDrill:                 { label: '🟠 Drill – Tsunami',                  color: 0xFFC0CB },
    unknown:                      { label: '⚠️ Unknown Alert',                    color: 0x808080 },
};

// ── State ─────────────────────────────────────────────────────────────────────

// Track alert IDs (or a fallback fingerprint) we have already posted
const postedAlerts = new Set();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns a stable string key for an alert so we don't double-post it.
 * Uses `id` when available, otherwise builds a fingerprint from type + cities.
 */
function alertKey(alert) {
    if (alert.id) return alert.id;
    return `${alert.type}|${(alert.cities || []).sort().join(',')}`;
}

/**
 * Builds a Discord embed object from a pikud-haoref alert.
 */
function buildEmbed(alert) {
    const meta  = ALERT_META[alert.type] || ALERT_META.unknown;
    const cities = alert.cities && alert.cities.length
        ? alert.cities.join(', ')
        : 'Unknown location';

    return {
        title:       meta.label,
        description: `**Areas affected:**\n${cities}`,
        color:       meta.color,
        fields:      alert.instructions
            ? [{ name: 'Instructions', value: alert.instructions }]
            : [],
        footer:      { text: `RedAlert Bot • ${new Date().toUTCString()}` },
        thumbnail:   { url: 'https://redalert.me/img/icon.png' },
    };
}

/**
 * Posts a single embed to the Discord webhook.
 */
async function postToDiscord(embed) {
    try {
        await axios.post(WEBHOOK_URL, { embeds: [embed] });
    } catch (err) {
        const status  = err.response ? err.response.status  : 'N/A';
        const details = err.response ? JSON.stringify(err.response.data) : err.message;
        console.error(`[ERROR] Discord webhook failed (HTTP ${status}): ${details}`);
    }
}

// ── Main polling loop ─────────────────────────────────────────────────────────

function poll() {
    const options = PROXY_URL ? { proxy: PROXY_URL } : {};

    pikudHaoref.getActiveAlerts((err, alerts) => {
        // Schedule next poll regardless of outcome
        setTimeout(poll, POLL_INTERVAL);

        if (err) {
            console.error('[ERROR] Failed to retrieve alerts:', err.message || err);
            return;
        }

        if (!alerts || alerts.length === 0) {
            // No active alerts – nothing to do
            return;
        }

        for (const alert of alerts) {
            const key = alertKey(alert);

            if (postedAlerts.has(key)) {
                // Already posted this alert
                continue;
            }

            postedAlerts.add(key);

            console.log(`[ALERT] New alert detected (${key}):`, JSON.stringify(alert));

            const embed = buildEmbed(alert);
            postToDiscord(embed);
        }
    }, options);
}

// ── Startup ───────────────────────────────────────────────────────────────────

console.log(`[INFO] RedAlert Discord Bot starting (polling every ${POLL_INTERVAL}ms) …`);
console.log('[INFO] Note: pikud-haoref-api only works from within Israel or via a proxy.');
poll();
