// SKTorrent Stremio addon s podporou multi-episode balikov a filtrovanim len na video subory
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { decode } = require("entities");
const axios = require("axios");
const cheerio = require("cheerio");
const parseTorrent = require("parse-torrent-file");
const bencode = require("bncode");
const crypto = require("crypto");

const SKT_UID = "tvoj_uid";
const SKT_PASS = "tvoj_pass_hash";
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
    RU: "🇷🇺", PL: "🇵🇱", HU: "🇭🇷", JP: "🇯🇵",
    KR: "🇰🇷", CN: "🇨🇳"
};

const validExtensions = [".mp4", ".mkv", ".avi", ".mov", ".webm", ".mpeg", ".mpg", ".ts", ".flv"];

function normalizeTitle(str) {
    return str.normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[\s:']/g, "")
        .toLowerCase();
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
        console.log(`[DEBUG] 🎭 Lokalizovaný názov: ${title}`);
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
            headers: { Cookie: `uid=${SKT_UID}; pass=${SKT_PASS}` }
        });
        const res = await session.get(SEARCH_URL, { params: { search: query, category: 0 } });
        const $ = cheerio.load(res.data);
        const posters = $('a[href^="details.php"] img');
        const results = [];
        posters.each((i, img) => {
            const parent = $(img).closest("a");
            const outerTd = parent.closest("td");
            const fullBlock = outerTd.text().replace(/\s+/g, ' ').trim();
            const href = parent.attr("href") || "";
            const tooltip = parent.attr("title") || "";
            const torrentId = href.split("id=").pop();
            const category = outerTd.find("b").first().text().trim();
            const sizeMatch = fullBlock.match(/Velkost\s([^|]+)/i);
            const seedMatch = fullBlock.match(/Odosielaju\s*:\s*(\d+)/i);
            const size = sizeMatch ? sizeMatch[1].trim() : "?";
            const seeds = seedMatch ? seedMatch[1] : "0";
            if (!category.toLowerCase().includes("film") && !category.toLowerCase().includes("seri")) return;
            results.push({
                name: tooltip,
                id: torrentId,
                size,
                seeds,
                category,
                downloadUrl: `${BASE_URL}/torrent/download.php?id=${torrentId}`
            });
        });
        console.log(`[INFO] 📦 Nájdených torrentov: ${results.length}`);
        return results;
    } catch (err) {
        console.error("[ERROR] Vyhľadávanie zlyhalo:", err.message);
        return [];
    }
}

async function toStream(t) {
    try {
        const res = await axios.get(t.downloadUrl, {
            responseType: "arraybuffer",
            headers: {
                Cookie: `uid=${SKT_UID}; pass=${SKT_PASS}`,
                Referer: BASE_URL
            }
        });
        const torrentInfo = parseTorrent(res.data);
        const files = torrentInfo.files || [];

        // Filtrovanie iba na dostatočne veľké video súbory
        const videoFile = files.find(f =>
            validExtensions.some(ext => f.name.toLowerCase().endsWith(ext)) &&
            f.length > 20 * 1024 * 1024 // aspoň 20 MB
        );
        if (!videoFile) return null;

        const langMatches = t.name.match(/\b([A-Z]{2})\b/g) || [];
        const flags = langMatches.map(code => langToFlag[code.toUpperCase()]).filter(Boolean);
        const flagsText = flags.length ? `\n${flags.join(" / ")}` : "";

        const cleanedTitle = t.name.replace(/^Stiahni si\s*/i, "").trim();
        const infoHash = torrentInfo.infoHash;

        return {
            title: `${cleanedTitle}\n👤 ${t.seeds}  💽 ${t.size}  🧲 sktorrent.eu${flagsText}`,
            name: `SKTorrent\n${t.category}`,
            behaviorHints: { bingeGroup: cleanedTitle },
            infoHash,
            fileIdx: videoFile ? files.indexOf(videoFile) : undefined
        };
    } catch (err) {
        console.error("[ERROR] ❌ Chyba pri spracovaní .torrent:", err.message);
        return null;
    }
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
    const clean = t => t.replace(/\(.*?\)/g, '').replace(/TV Series|TV Mini Series/gi, '').trim();
    const t1 = clean(title);
    const t2 = clean(originalTitle);
    const seasonEp = (season && episode) ? ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : "";

    const queries = [];
    if (type === 'series') {
        queries.push(`${t1}${seasonEp}`, `${t2}${seasonEp}`);
        queries.push(`${normalizeTitle(t2)}${seasonEp}`);
        queries.push(`${normalizeTitle(t2 + seasonEp).replace(/\s+/g, '.')}`);
    } else {
        queries.push(t1, t2, normalizeTitle(t2), normalizeTitle(t2).replace(/\s+/g, '.'));
    }

    let torrents = [];
    for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        console.log(`[DEBUG] 🔍 Pokus ${i + 1}: Hľadám '${q}'`);
        torrents = await searchTorrents(q);
        if (torrents.length > 0) break;
    }

    const streams = (await Promise.all(torrents.map(toStream))).filter(Boolean);
    console.log(`[INFO] ✅ Odosielam ${streams.length} streamov do Stremio`);
    return { streams };
});

builder.defineCatalogHandler(({ type, id }) => {
    console.log(`[DEBUG] 📚 Katalóg požiadavka pre typ='${type}' id='${id}'`);
    return { metas: [] };
});

console.log("📎 Manifest debug výpis:", builder.getInterface().manifest);
serveHTTP(builder.getInterface(), { port: 7000 });
console.log("🚀 SKTorrent addon beží na http://localhost:7000/manifest.json");
