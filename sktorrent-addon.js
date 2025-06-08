// SKTorrent Stremio addon s pokročilým fallback systémom pre filmy a seriály
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { decode } = require("entities");
const axios = require("axios");
const cheerio = require("cheerio");
const bencode = require("bncode");
const crypto = require("crypto");

function generateQueries(original, localized, season, episode) {
    const variants = new Set();

    const clean = t => t
        .replace(/\(.*?\)/g, '') // odstráni roky a zátvorky
        .replace(/TV (Mini )?Series/gi, '')
        .replace(/[:\-–—]/g, ' ') // odstráni dvojbodky a pomlčky
        .trim();

    const noDia = str => str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const shorten = str => str.replace(/[^a-zA-Z0-9 ]/g, '').trim();

    const orig = clean(original);
    const loc = clean(localized);

    // Poradie: lokalizovaný názov má prioritu, potom originálny, potom kombinácie
    const bases = [
        loc,
        orig,
        `${loc} ${orig}`,
        `${orig} ${loc}`
    ];

    const epTag = (season && episode) ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : '';

    for (const base of bases) {
        if (!base) continue;

        const baseClean = shorten(noDia(base));

        if (epTag) {
            variants.add(`${base} ${epTag}`);
            variants.add(`${baseClean}${epTag}`);
            variants.add(`${base.replace(/\s+/g, '.')} .${epTag}`);
            variants.add(`${base.replace(/\s+/g, '.')} ${epTag}`);
            variants.add(`${baseClean}.${epTag}`);
        } else {
            variants.add(base);
            variants.add(baseClean);
            variants.add(base.replace(/\s+/g, '.'));
        }
    }

    return Array.from(variants);
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

function isMultiSeason(title) {
    // Rozšírená detekcia multi-season balíkov
    return /(S\d{1,2}E\d{2}(-\d{2})?|Complete|All Episodes|Season(s)? \d+(-\d+)?)/i.test(title);
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

            const href = parent.attr("href") || "";
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

            // Zobraz prvých 1000 znakov odpovede na debug
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

const getCzSkTitle = async (imdbId) => {
    try {
        const url = `https://www.csfd.cz/hledat/?q=${imdbId}`;
        const { data } = await axios.get(url);
        const $ = cheerio.load(data);
        const foundLink = $(".film .film-title a").first().attr("href");
        if (!foundLink) return null;
        const titlePageUrl = `https://www.csfd.cz${foundLink}`;
        const res = await axios.get(titlePageUrl);
        const $$ = cheerio.load(res.data);
        return $$("title").text().split("|")[0].trim();
    } catch {
        return null;
    }
};

builder.defineStreamHandler(async ({ type, id, name, season, episode }) => {
    if (type !== "movie" && type !== "series") {
        return { streams: [] };
    }

    // Získaj názvy (lokalizovaný aj originálny) z IMDb
    const titles = await getTitleFromIMDb(id);
    if (!titles) return { streams: [] };

    // Vygeneruj množinu vyhľadávacích dotazov
    const queries = generateQueries(titles.originalTitle, titles.title, season, episode);

    // Pre každý query hľadaj torrenty a vyber tie, ktoré nie sú multi-season
    for (const query of queries) {
        const torrents = await searchTorrents(query);
        if (!torrents.length) {
            console.log(`[DEBUG] 🕵️‍♂️ Žiadne výsledky pre query: '${query}'`);
            continue;
        }

        // Vytvor streamy z torrentov, filtrovaním multi-season balíkov
        const streams = [];
        for (const t of torrents) {
            const stream = await toStream(t);
            if (stream) streams.push(stream);
        }

        if (streams.length) {
            console.log(`[INFO] ✅ Vrátené streamy pre query: '${query}' (${streams.length} položiek)`);
            return { streams };
        }
    }

    console.log("[WARN] ⚠️ Nepodarilo sa nájsť žiadne streamy pre daný titul.");
    return { streams: [] };
});

serveHTTP(builder);
