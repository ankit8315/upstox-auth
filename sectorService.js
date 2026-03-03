// sectorService.js — Tracks NSE sector performance + builds heatmap data
// Uses NSE free APIs for index data

const axios = require("axios");

let cache = { sectors: null, fetchedAt: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000;

const NSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept": "application/json",
  "Referer": "https://www.nseindia.com/"
};

// NSE sectoral indices
const SECTOR_INDICES = [
  { key: "NIFTY_BANK",       name: "Banking",       symbol: "NIFTY BANK"        },
  { key: "NIFTY_IT",         name: "IT",            symbol: "NIFTY IT"          },
  { key: "NIFTY_PHARMA",     name: "Pharma",        symbol: "NIFTY PHARMA"      },
  { key: "NIFTY_AUTO",       name: "Auto",          symbol: "NIFTY AUTO"        },
  { key: "NIFTY_FMCG",       name: "FMCG",          symbol: "NIFTY FMCG"        },
  { key: "NIFTY_METAL",      name: "Metal",         symbol: "NIFTY METAL"       },
  { key: "NIFTY_ENERGY",     name: "Energy",        symbol: "NIFTY ENERGY"      },
  { key: "NIFTY_REALTY",     name: "Realty",        symbol: "NIFTY REALTY"      },
  { key: "NIFTY_INFRA",      name: "Infra",         symbol: "NIFTY INFRA"       },
  { key: "NIFTY_MEDIA",      name: "Media",         symbol: "NIFTY MEDIA"       },
  { key: "NIFTY_PSU_BANK",   name: "PSU Bank",      symbol: "NIFTY PSU BANK"    },
  { key: "NIFTY_MNC",        name: "MNC",           symbol: "NIFTY MNC"         }
];

async function fetchSectors() {
  const now = Date.now();
  if (cache.sectors && now - cache.fetchedAt < CACHE_TTL_MS) return cache.sectors;

  const session = axios.create({ headers: NSE_HEADERS, timeout: 10000 });
  const sectors = [];

  try {
    // Get NSE cookies first
    await session.get("https://www.nseindia.com/");
    await new Promise(r => setTimeout(r, 800));

    // Fetch all indices at once
    const resp = await session.get("https://www.nseindia.com/api/allIndices");
    const allIndices = resp.data && resp.data.data || [];

    for (const si of SECTOR_INDICES) {
      const match = allIndices.find(i => i.index === si.symbol);
      if (match) {
        const change = parseFloat(match.percentChange || 0);
        sectors.push({
          key:           si.key,
          name:          si.name,
          ltp:           parseFloat(match.last || 0),
          change:        change,
          changeAbs:     parseFloat(match.change || 0),
          open:          parseFloat(match.open || 0),
          high:          parseFloat(match.high || 0),
          low:           parseFloat(match.low || 0),
          strength:      Math.abs(change) > 1.5 ? "STRONG" : Math.abs(change) > 0.5 ? "MODERATE" : "WEAK",
          direction:     change > 0 ? "up" : change < 0 ? "down" : "flat",
          heatScore:     change // -5 to +5 typically
        });
      }
    }
  } catch (e) {
    console.error("Sector fetch error:", e.message);
    // Return mock structure so app doesn't break
    for (const si of SECTOR_INDICES) {
      sectors.push({
        key: si.key, name: si.name,
        ltp: 0, change: 0, changeAbs: 0,
        strength: "UNKNOWN", direction: "flat", heatScore: 0
      });
    }
  }

  // Sort by change desc (hot sectors first)
  sectors.sort((a, b) => b.change - a.change);

  // Derive market breadth signal
  const advancing = sectors.filter(s => s.change > 0).length;
  const declining  = sectors.filter(s => s.change < 0).length;
  const breadth    = {
    advancing,
    declining,
    ratio: sectors.length > 0 ? advancing / sectors.length : 0.5,
    signal: advancing > declining * 1.5
      ? "BROAD_RALLY"
      : declining > advancing * 1.5
      ? "BROAD_SELLOFF"
      : "MIXED"
  };

  const result = { sectors, breadth, fetchedAt: new Date().toISOString() };
  cache = { sectors: result, fetchedAt: now };
  console.log("Sectors fetched: " + sectors.length + " | Advancing: " + advancing + " Declining: " + declining);
  return result;
}

module.exports = { fetchSectors };
