// fnoRegistry.js
// Provides the F&O eligible stock list and sector map.
//
// STRATEGY (NSE blocks GCP datacenter IPs — fo-marketlot returns 404):
//   Built-in complete F&O list — always works instantly, updated quarterly.
//   No HTTP calls needed. Registry is synchronous and pre-populated at load time.

const FNO_SECTORS = {
  Bank:     ["HDFCBANK","ICICIBANK","SBIN","AXISBANK","KOTAKBANK","INDUSINDBK","BANDHANBNK","IDFCFIRSTB","FEDERALBNK","RBLBANK","PNB","BANKBARODA","CANBK","UNIONBANK","AUBANK","KARURVYSYA","SOUTHBANK","UJJIVANSFB"],
  IT:       ["INFY","TCS","WIPRO","HCLTECH","TECHM","LTIM","PERSISTENT","COFORGE","MPHASIS","LTTS","OFSS","KPITTECH","TATAELXSI","ZENSARTECH","CYIENT","NEWGEN","MASTEK","BSOFT"],
  Energy:   ["RELIANCE","ONGC","OIL","BPCL","HPCL","IOC","PETRONET","GAIL","MGL","IGL","GSPL","GUJGASLTD","ATGL","ADANIGREEN","ADANIPOWER","TATAPOWER","TORNTPOWER","NHPC","NTPC","POWERGRID","CESC","JSWENERGY"],
  Auto:     ["TATAMOTORS","M&M","MARUTI","BAJAJ-AUTO","HEROMOTOCO","EICHERMOT","TVSMOTOR","ASHOKLEY","ESCORTS","BALKRISIND","MRF","CEATLTD","APOLLOTYRE","MOTHERSON","EXIDEIND","TIINDIA","AMARAJABAT"],
  Pharma:   ["SUNPHARMA","DRREDDY","CIPLA","DIVISLAB","AUROPHARMA","LUPIN","BIOCON","GLENMARK","TORNTPHARM","ALKEM","IPCALAB","NATCOPHARM","LAURUSLABS","GRANULES","ZYDUSLIFE","AJANTPHARM"],
  FMCG:     ["HINDUNILVR","ITC","NESTLEIND","BRITANNIA","DABUR","GODREJCP","MARICO","COLPAL","EMAMILTD","TATACONSUM","VBL","RADICO","MCDOWELL-N","PGHH"],
  Metal:    ["TATASTEEL","JSWSTEEL","HINDALCO","COALINDIA","NMDC","VEDL","HINDZINC","NATIONALUM","SAIL","MOIL","WELCORP","APLAPOLLO","RATNAMANI","JINDALSAW"],
  Finance:  ["BAJFINANCE","BAJAJFINSV","CHOLAFIN","MUTHOOTFIN","MANAPPURAM","LICHSGFIN","RECLTD","PFC","IRFC","HUDCO","M&MFIN","SHRIRAMFIN","ABCAPITAL","HDFCAMC","ICICIGI","ICICIPRULI","SBILIFE","HDFCLIFE","LICI"],
  Infra:    ["LT","ADANIPORTS","GMRINFRA","IRB","CONCOR","IRCON","RVNL","NCC","HCC","KNRCON","PNCINFRA","GPPL"],
  Realty:   ["DLF","GODREJPROP","PRESTIGE","BRIGADE","OBEROIRLTY","PHOENIXLTD","SOBHA","MAHLIFE","LODHA"],
  Chemicals:["PIDILITIND","ASIANPAINT","BERGER","KANSAINER","VINATIORGA","DEEPAKNTR","ATUL","NAVINFLUOR","TATACHEM","GNFC","COROMANDEL","CHAMBLFERT","PIIND"],
  Defense:  ["HAL","BEL","BHEL","BEML","MIDHANI","COCHINSHIP","MAZAGON","GRSE","DATAPATTNS"],
  Telecom:  ["BHARTIARTL","IDEA","TATACOMM","HFCL","RAILTEL"],
  Misc:     ["TITAN","HAVELLS","VOLTAS","PAGEIND","SIEMENS","ABB","CUMMINSIND","THERMAX","BOSCH","POLYCAB","DIXON","AMBER","CROMPTON","CGPOWER","SUZLON","IRCTC","ADANIENT","LTTS","KAYNES","TRENT","DMART","NYKAA","ZEEL","SUNTV","PVRINOX"]
};

const BUILTIN_FNO_SET = new Set(Object.values(FNO_SECTORS).flat());

const BUILTIN_SECTOR_MAP = {};
for (const [sector, symbols] of Object.entries(FNO_SECTORS)) {
  for (const sym of symbols) BUILTIN_SECTOR_MAP[sym] = sector;
}

const TOP_LIQUID_FALLBACK = [
  { symbol:"RELIANCE",  sector:"Energy"  },{ symbol:"HDFCBANK",  sector:"Bank"    },
  { symbol:"ICICIBANK", sector:"Bank"    },{ symbol:"INFY",      sector:"IT"      },
  { symbol:"TCS",       sector:"IT"      },{ symbol:"SBIN",      sector:"Bank"    },
  { symbol:"AXISBANK",  sector:"Bank"    },{ symbol:"BAJFINANCE",sector:"Finance" },
  { symbol:"TATAMOTORS",sector:"Auto"    },{ symbol:"KOTAKBANK", sector:"Bank"    },
  { symbol:"LT",        sector:"Infra"   },{ symbol:"ADANIENT",  sector:"Misc"    },
  { symbol:"WIPRO",     sector:"IT"      },{ symbol:"HCLTECH",   sector:"IT"      },
  { symbol:"SUNPHARMA", sector:"Pharma"  },
];

function buildFallback(list) {
  return list.map(s => ({
    symbol: s.symbol, companyName: s.symbol,
    sector: s.sector || BUILTIN_SECTOR_MAP[s.symbol] || "Other",
    tradeType: "MOMENTUM", direction: "LONG", confidence: 5,
    thesis: "Top F&O liquid stock — monitoring for momentum"
  }));
}

// Registry is pre-populated synchronously — no waiting, no HTTP calls needed
const registry = {
  fnoStocks:        BUILTIN_FNO_SET,
  sectorMap:        BUILTIN_SECTOR_MAP,
  fallbackWatchlist: buildFallback(TOP_LIQUID_FALLBACK),
};

console.log("[fnoRegistry] Ready: " + BUILTIN_FNO_SET.size + " F&O stocks, " + Object.keys(BUILTIN_SECTOR_MAP).length + " sector mappings");

// Public API — all synchronous
function getFNOStocks()        { return registry.fnoStocks; }
function getSectorMap()        { return registry.sectorMap; }
function getFallbackWatchlist(){ return registry.fallbackWatchlist; }
function isFNOStock(symbol)    { return registry.fnoStocks.has(symbol.replace(/^(NSE_EQ|BSE_EQ)\|/,"").toUpperCase().trim()); }
function getSectorForSymbol(s) { return registry.sectorMap[s.replace(/^(NSE_EQ|BSE_EQ)\|/,"").toUpperCase().trim()] || "Other"; }
async function ensureLoaded()  { return; }  // no-op — kept for API compatibility
async function refreshRegistry(){ console.log("[fnoRegistry] Built-in registry active — no refresh needed"); }

module.exports = { getFNOStocks, getSectorMap, getFallbackWatchlist, isFNOStock, getSectorForSymbol, ensureLoaded, refreshRegistry };
