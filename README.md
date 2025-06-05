# Sktorrent-Stremio-addon

Tento neoficiálny doplnok pre [Stremio](https://www.stremio.com/) umožňuje vyhľadávať a streamovať filmy a seriály z populárneho slovenského torrent trackera **SKTorrent.eu** priamo cez Stremio rozhranie.

## 🔧 Funkcie

- Vyhľadávanie filmov aj seriálov podľa názvu z IMDb (vrátane fallback variant).
- Podpora sezón a epizód v rôznych formátoch (`S01E01`, `1. serie`, `Season 3`, atď.).
- Detekcia a selekcia relevantných multimediálnych súborov z multi-epizódnych torrent balíkov.
- Filtrovanie podľa veľkosti, typu súboru (.mkv, .mp4, .avi, atď.).
- Automatická extrakcia `infoHash` zo `.torrent` súborov (funkcia je vo vývoji pre multi-session torrenty).
- Piktogramy jazykových vlajok a CSFD rating v názve streamu.

## 🧪 Lokálna inštalácia a testovanie

### 1. Klonovanie projektu
```bash
git clone https://github.com/tvoje-username/sktorrent-stremio-addon.git
cd sktorrent-stremio-addon
npm init -y
```

### 2. Inštalácia závislostí

```bash
npm install axios cheerio stremio-addon-sdk axios-cookiejar-support tough-cookie bncode entities parse-torrent-file
```

Poznámka: Je odporúčané používať Node.js verziu >=18, testované s Node.js v20.09 LTS

### 3. Spustenie lokálneho servera
```bash
node sktorrent-addon.js
```

Ak je všetko správne nakonfigurované, doplnok bude bežať na:

http://localhost:7000/manifest.json

## 🔗 Pridanie doplnku do aplikácie Stremio

- Otvor Stremio desktop alebo webovú aplikáciu.
- Choď na Add-ons > Community Add-ons > "Install via URL"
- Vlož adresu: http://localhost:7000/manifest.json

## 📁 Konfigurácia

Autentifikácia na stránke SKTorrent.eu je pre lokálne testovanie doplnku momentálne riešená pevne zadanými cookies (uid, pass) v zdrojovom kóde. Každý používateľ by si mal upraviť svoj vlastný login údaj pre korektné fungovanie:
```js
const SKT_UID = "tvoj_uid";
const SKT_PASS = "tvoj_pass_hash";
```

## ⚠️ Upozornenie

**Tento doplnok je určený výhradne na osobné, vývojové a experimentálne účely.**

Používanie tohto doplnku pre prístup k chránenému obsahu je **na vlastné riziko**.
Autor nenesie **žiadnu zodpovednosť** za prípadné porušenie autorských práv alebo právnych predpisov vyplývajúcich z používania tohto nástroja.
Tento projekt **nepropaguje pirátstvo**, ale demonštruje technické možnosti rozšírenia Stremio platformy.
