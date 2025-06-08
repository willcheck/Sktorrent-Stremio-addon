// SKTorrent Stremio addon s pokročilým fallback systémom pre filmy a seriály
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { decode } = require("entities");
const axios = require("axios");
const cheerio = require("cheerio");
const bencode = require("bncode");
const crypto = require("crypto");

function generateQueries(title, localizedTitle, season, episode) {
    const queries = new Set();
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');

    const formats = [
        `${title} S${s}E${e}`,
        `${title} ${season}x${episode}`,
        `${title} Season ${season} Episode ${episode}`,
        `${title} S${s}`,
        `${title} Season ${season}`,
        `${title}`,
    ];

    formats.forEach(q => queries.add(q));

    if (localizedTitle && localizedTitle.toLowerCase() !== title.toLowerCase()) {
        const localizedFormats = [
            `${localizedTitle} S${s}E${e}`,
            `${localizedTitle} ${season}x${episode}`,
            `${localizedTitle} Season ${season} Episode ${episode}`,
            `${localizedTitle} S${s}`,
            `${localizedTitle} Season ${season}`,
            `${localizedTitle}`,
        ];
        localizedFormats.forEach(q => queries.add(q));
    }

    return Array.from(queries);
}


const SKT_UID = process.env.SKT_UID || "9169";
const SKT_PASS = process.env.SKT_PASS || "4394204647bafe4871e624cd93270ca8";

const BASE_URL = "https://sktorrent.eu";
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;

const builder = addonBuilder({
    id: "org.stremio.sktorrent",
    version: "1.0.0",
    name: "SKTorrent",
    description: "Streamuj torrenty z SKTorrent.eu (filmy aj seriály)",
    types: ["movie", "series"],
    catalogs: [
        { type: "movie", id: "sktorrent-movie", name: "SKTorrent Filmy" },
        { type: "series", id: "sktorrent-series", name: "SKTorrent Seriály" }
    ],
    resources: ["stream"],
    idPrefixes: ["tt"]
});

const langToFlag = {
    CZ: "🇨🇿", SK: "🇸🇰", EN: "🇬🇧", US: "🇺🇸",
    DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸",
    RU: "🇷🇺", PL: "🇵🇱", HU: "🇭🇺", JP: "🇯🇵",
    KR: "🇰🇷", CN: "🇨🇳"
};

function removeDiacritics(str) {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function shortenTitle(title, wordCount = 3) {
    return title.split(/\s+/).slice(0, wordCount).join(" ");
}

function isMultiSeason(title) {
    return /(S\d{2}E\d{2}-\d{2}|Complete|All Episodes|Season \d+(-\d+)?)/i.test(title);
}

async function getTitleFromIMDb(imdbId) {
    try {
        const res = await axios.get(`https://www.imdb.com/title/${imdbId}/`, {
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        const $ = cheerio.load(res.data);
        const titleRaw = $('title').text().split(' - ')[0].trim();
        const title = decode(titleRaw);
        const ldJson = $('script[type="application/ld+json"]').html();
        let originalTitle = title;
        if (ldJson) {
            const json = JSON.parse(ldJson);
            if (json && json.name) originalTitle = decode(json.name.trim());
        }
        console.log(`[DEBUG] 🌝 Lokalizovaný názov: ${title}`);
        console.log(`[DEBUG] 🇳️ Originálny názov: ${originalTitle}`);
        return { title, originalTitle };
    } catch (err) {
        console.error("[ERROR] IMDb scraping zlyhal:", err.message);
        return null;
    }
}

async function searchTorrents(query) {
    console.log(`[INFO] 🔎 Hľadám '${query}' na SKTorrent...`);
    try {
        const session = axios.create({
  headers: {
    Cookie: `uid=${SKT_UID}; pass=${SKT_PASS}`,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    Referer: BASE_URL
  }
});

        const res = await session.get(SEARCH_URL, { params: { search: query, category: 0 } });
        const $ = cheerio.load(res.data);
        const posters = $('a[href^="details.php"] img');
        const results = [];

posters.each((i, img) => {
    const parent = $(img).closest("a");
    const outerTd = parent.closest("td");
    const fullBlock = outerTd.text().replace(/\s+/g, ' ').trim();

    const href = parent.attr("href") || "";  // celý odkaz vrátane id, f, seed
    const tooltip = parent.attr("title") || "";
    const category = outerTd.find("b").first().text().trim();

    const rawId = href.match(/id=([^&]+)/)?.[1];
    const filename = href.match(/f=([^&]+)/)?.[1];
    const seed = href.includes("seed=1") ? "&seed=1" : "";

    const sizeMatch = fullBlock.match(/Velkost\s([^|]+)/i);
    const seedMatch = fullBlock.match(/Odosielaju\s*:\s*(\d+)/i);
    const size = sizeMatch ? sizeMatch[1].trim() : "?";
    const seeds = seedMatch ? seedMatch[1] : "0";

    if (!rawId || (!category.toLowerCase().includes("film") && !category.toLowerCase().includes("seri"))) return;

    const downloadUrl = `${BASE_URL}/torrent/download.php?id=${rawId}${filename ? `&f=${encodeURIComponent(filename)}` : ''}${seed}`;

    results.push({
        name: tooltip,
        id: rawId,
        size,
        seeds,
        category,
        downloadUrl
    });
});

        console.log(`[INFO] 📦 Nájdených torrentov: ${results.length}`);
        return results;
    } catch (err) {
        console.error("[ERROR] Vyhľadávanie zlyhalo:", err.message);
        return [];
    }
}

async function getInfoHashFromTorrent(url) {
    try {
        const res = await axios.get(url, {
            responseType: "arraybuffer",
            headers: {
                Cookie: `uid=${SKT_UID}; pass=${SKT_PASS}`,
                Referer: BASE_URL,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            }
        });

        const contentType = res.headers["content-type"];
        if (!contentType || !contentType.includes("application/x-bittorrent") || res.data[0] !== 0x64) {
            console.error("[ERROR] ⛔️ Server nevrátil .torrent súbor");

            // Skús zobraziť celú odpoveď ako text, aby sme videli čo sa vrátilo
            const textPreview = res.data.toString("utf8", 0, 1000);
            console.log("[DEBUG] 🔍 Odpoveď servera (prvých 1000 znakov):\n", textPreview);
            return null;
        }

        const torrent = bencode.decode(res.data);
        const info = bencode.encode(torrent.info);
        const infoHash = crypto.createHash("sha1").update(info).digest("hex");
        return infoHash;
    } catch (err) {
        console.error("[ERROR] ⛔️ Chyba pri spracovaní .torrent:", err.message);
        return null;
    }
}


async function toStream(t) {
    if (isMultiSeason(t.name)) {
        console.log(`[DEBUG] ❌ Preskakujem multi-season balík: '${t.name}'`);
        return null;
    }
    const langMatches = t.name.match(/\b([A-Z]{2})\b/g) || [];
    const flags = langMatches.map(code => langToFlag[code.toUpperCase()]).filter(Boolean);
    const flagsText = flags.length ? `\n${flags.join(" / ")}` : "";

    let cleanedTitle = t.name.replace(/^Stiahni si\s*/i, "").trim();
    const categoryPrefix = t.category.trim().toLowerCase();
    if (cleanedTitle.toLowerCase().startsWith(categoryPrefix)) {
        cleanedTitle = cleanedTitle.slice(t.category.length).trim();
    }

    const infoHash = await getInfoHashFromTorrent(t.downloadUrl);
    if (!infoHash) return null;

    return {
        title: `${cleanedTitle}\n👤 ${t.seeds}  📀 ${t.size}  🩲 sktorrent.eu${flagsText}`,
        name: `SKTorrent\n${t.category}`,
        behaviorHints: { bingeGroup: cleanedTitle },
        infoHash
    };
}

builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`\n====== 🎮 RAW Požiadavka: type='${type}', id='${id}' ======`);

    const [imdbId, sRaw, eRaw] = id.split(":");
    const season = sRaw ? parseInt(sRaw) : undefined;
    const episode = eRaw ? parseInt(eRaw) : undefined;

    console.log(`====== 🎮 STREAM Požiadavka pre typ='${type}' imdbId='${imdbId}' season='${season}' episode='${episode}' ======`);

    const titles = await getTitleFromIMDb(imdbId);
    if (!titles) return { streams: [] };

    const { title, originalTitle } = titles;

    const queries = generateQueries(originalTitle, title, season, episode); // 👈 používaš novú funkciu

    let torrents = [];
    let attempt = 1;
    for (const q of queries) {
        console.log(`[DEBUG] 🔍 Pokus ${attempt++}: Hľadám '${q}'`);
        torrents = await searchTorrents(q);
        if (torrents.length > 0) break;
    }

    const streams = (await Promise.all(torrents.map(toStream))).filter(Boolean);
    console.log(`[INFO] ✅ Odosielam ${streams.length} streamov do Stremio`);
    return { streams };
});


builder.defineCatalogHandler(async ({ type, id }) => {
    console.log(`[DEBUG] 📚 Katalóg požiadavka pre typ='${type}' id='${id}'`);
    return { metas: [] }; // aktivuje prepojenie
});


console.log("\ud83d\udccc Manifest debug výpis:", builder.getInterface().manifest);
serveHTTP(builder.getInterface(), { port: 7000 });
console.log("\ud83d\ude80 SKTorrent addon beží na http://localhost:7000/manifest.json");
